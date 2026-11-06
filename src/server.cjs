'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {load,validate:baseConfig}=require('./config.cjs'),{readJSON,writeJSON}=require('./store.cjs');
const {initial,validate,expand,command,plcBrands,hmiBrands}=require('./profiles.cjs');
const {Session,listen,pointTable}=require('./session.cjs');
const assist=require('./assist.cjs'),{checkSession,startScreen,confirmScreen}=require('./assist-check.cjs');
const {inspectPath}=require('./project-files.cjs'),{inventory}=require('./assist-inventory.cjs');
const {Journal,browser,reason,appVersion}=require('./diagnostics.cjs');
const {observed,operation,inputKind}=require('./diagnostic-events.cjs');
const {analyse,merge}=require('./protocol-import.cjs'),{MAX_BYTES,formatOf}=require('./protocol-files.cjs');
const rootDir=path.resolve(__dirname,'..');
const assetMap={'/':'index.html','/physical':'index.html','/platform':'index.html','/local-text.js':'local-text.js','/protocol-import.js':'protocol-import.js','/protocol-import.css':'protocol-import.css','/assist.js':'assist.js','/report-format.js':'report-format.js','/diagnostics.js':'diagnostics.js','/assist.css':'assist.css','/app.js':'app.js','/style.css':'style.css','/guide':'guide.html'};
function csv(p){
  const col=x=>'"'+String(x).replaceAll('"','""')+'"';
  return '\uFEFF'+[['区域','逻辑零基地址','驱动地址','宽度','变量名','说明','权限'],...pointTable(p).map(x=>[x.area,x.address,x.native,x.width,x.name,x.meaning,x.access])].map(row=>row.map(col).join(',')).join('\r\n');
}
async function readUpload(req){
  if(!String(req.headers['content-type']||'').startsWith('application/octet-stream'))throw Error('上传文件类型无效');
  if(Number(req.headers['content-length'])>MAX_BYTES)throw Error('单个文件不能超过 8 MB');
  const parts=[];let size=0;
  for await(const part of req){size+=part.length;if(size>MAX_BYTES)throw Error('单个文件不能超过 8 MB');parts.push(part);}
  return Buffer.concat(parts);
}
async function readBody(req,limit=1048576){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('请使用 JSON');
  let total=0;const parts=[];for await(const b of req){total+=b.length;if(total>limit)throw Error('请求内容过大，请分批导入');parts.push(b);}
  const obj=JSON.parse(Buffer.concat(parts).toString()||'{}');if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('请求格式有误');return obj;
}
async function start(root=rootDir,override,options={}){
  const c=baseConfig(override||load(root)),dir=options.dataDir||path.join(root,'data');
  const journal=new Journal(dir);
  const file=path.join(dir,'projects.json');
  let db=readJSON(file,{schema:1,active:'general',profiles:[initial(),initial(true)]});
  if(db.schema!==1||!Array.isArray(db.profiles)||!db.profiles.length)throw Error('项目库格式有误');
  db.profiles.forEach(validate);if(!db.profiles.some(p=>p.id===db.active))throw Error('未找到当前项目');
  const instance=options.instance||crypto.randomBytes(24).toString('hex');
  const openedPages=new Map(); // 本次启动窗口的回执只在内存保留，不写入报告。
  let parsing=false;let session,changing=false,closing=false,users=0,epoch=crypto.randomUUID();
  function profile(){return db.profiles.find(p=>p.id===db.active);}
  async function open(p){
    journal.seen.clear();
    const s=new Session(c,p,path.join(dir,'projects',p.id),journal);
    try{return await s.init();}catch(e){await s.close();throw e;}
  }
  function state(){const current=profile();
    const project=current.messageExamples?{...current,messageExamples:current.messageExamples.map(({id,name,topic,qos})=>({id,name,topic,qos}))}:current;
    return {project,projects:db.profiles.map(({id,name})=>({id,name})),ports:c.ports,epoch,brands:{plc:plcBrands,hmi:hmiBrands},...session.snapshot()};}
  function save(next){writeJSON(file,next);db=next;}
  async function switchTo(p,newProfiles){
    validate(p);if(changing||users||session.ioCount||session.wire.inFlight||session.localPulses.size)throw Error('正在处理操作，请稍后切换项目');
    changing=true;const old=profile();
    try{
      await session.refresh();
      if(session.model?.busy||session.lastState?.busy)throw Error('请先结束当前任务');
      if(session.wire.uncertain)throw Error('请先核对已提交的 PLC 请求');
      if(newProfiles.some(x=>x.id!==p.id&&x.device===p.device))throw Error('设备编号与其他项目重复');
      if(p.source==='native'&&p.port===c.ports.mqtt||p.source==='native'&&p.port===c.ports.http)throw Error('PLC 目标端口与平台服务冲突');
      await session.close();
      try{
        session=await open(p);
        save({schema:1,active:p.id,profiles:newProfiles});
      }catch(e){if(session&&!session.closed)await session.close();session=await open(old);throw e;}
      epoch=crypto.randomUUID();journal.record(p,'project.apply','pass');return state();
    }finally{changing=false;}
  }
  const web=http.createServer(async(req,res)=>{
    let route='',d={},diagnosticProfile;
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
    try{
      const hosts=['127.0.0.1:'+c.ports.http,'localhost:'+c.ports.http];
      if(!hosts.includes(req.headers.host)||req.headers.origin&&!hosts.some(h=>req.headers.origin==='http://'+h))return send(403,{error:'仅允许本机同源访问'});
      const u=new URL(req.url,'http://127.0.0.1');route=u.pathname;
      if(route==='/health'){
        const status={service:'industrial-device-bench',version:appVersion,projectId:c.projectId,instance,pid:process.pid,root:path.resolve(root),ready:!!session&&!closing&&!changing};
        if(u.searchParams.has('launch'))status.pageReady=(openedPages.get(u.searchParams.get('launch'))||0)>Date.now();
        return send(200,status);
      }
      if(req.method==='GET'&&Object.hasOwn(assetMap,route)){
        const name=assetMap[route];return send(200,fs.readFileSync(path.join(root,'web',name)),({js:'text/javascript',css:'text/css',html:'text/html'})[name.split('.').pop()]+'; charset=utf-8');
      }
      if(changing||closing||!session)return send(503,{error:'项目正在切换，请稍候'});
      if(req.method==='GET'){
        if(route==='/api/state')return send(200,state());
        if(route==='/api/diagnostics')return send(200,journal.report());
        if(route==='/api/assist/catalog')return send(200,{routes:assist.routes,kits:assist.kits,screens:assist.screens,drivers:assist.driverNames,ports:assist.defaultPorts,current:assist.infer(profile())});
        if(route==='/api/protocol/example'){const row=profile().messageExamples?.find(x=>x.id===u.searchParams.get('id'));return send(row?200:404,row||{error:'未找到该样例'});}
        if(route==='/api/points.csv')return send(200,csv(profile()),'text/csv; charset=utf-8');
        if(route==='/api/export')return send(200,{format:'industrial-bench/1',project:profile()});
        if(route==='/api/frames.csv'){
          const lines=[['时间','方向','客户端','主题','QoS','原始报文'],...session.frames.map(f=>[new Date(f.time).toISOString(),f.flow,f.client,f.topic,f.qos,f.raw])];
          const safe=v=>{const s=String(v);return '"'+(/^[=+@\-\t\r]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';};
          return send(200,'\uFEFF'+lines.map(l=>l.map(safe).join(',')).join('\r\n'),'text/csv; charset=utf-8');
        }
        if(route==='/api/frame'){const item=session.frames.find(f=>f.id===u.searchParams.get('id'));return send(item?200:404,item||{error:'报文已滚出窗口'});}
      }
      if(req.method!=='POST')return send(404,{error:'未找到入口'});
      if(route==='/api/protocol/analyse'){
        if(req.headers['x-bench-epoch']!==epoch)return send(409,{error:'项目已切换，请重新选择文件'});
        if(parsing)return send(429,{error:'另一个文件正在识别，请稍后重试'});
        const ext=u.searchParams.get('type')||'';if(!/^[a-z]{2,5}$/.test(ext))throw Error('文件扩展名无效');
        formatOf('upload.'+ext);parsing=true;users++;
        try{const found=await analyse(await readUpload(req),'upload.'+ext);
          journal.record(profile(),'files.scan',found.candidates.length?'pass':'wait',found.candidates.length?'none':'missing',{count:found.candidates.length});
          return send(200,found);
        }finally{parsing=false;users--;}
      }
      d=await readBody(req,['/api/protocol/import','/api/project/import','/api/project/save'].includes(route)?4*1048576:1048576);
      if(route==='/api/shutdown'){
        if(d.projectId!==c.projectId||d.instance!==instance)return send(403,{error:'实例不匹配'});
        send(200,{stopping:true});setTimeout(()=>stop().then(()=>options.onStop?.()),50);return;
      }
      if(changing||closing||d.epoch!==epoch)return send(409,{error:'操作界面已过期，请刷新后重试'});
      if(route==='/api/diagnostics/browser'){
        const info=browser(req.headers['user-agent']);
        if(d.kind==='open'){
          journal.record(profile(),'browser.open','info','none',info,'browser.'+info.browser);
          if(typeof d.launch==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(d.launch)){
            openedPages.set(d.launch,Date.now()+60000);
            if(openedPages.size>32)openedPages.delete(openedPages.keys().next().value);
          }
        }
        else if(['script','rejection'].includes(d.kind))journal.record(profile(),'browser.error','fail',d.kind,{...info,component:d.component},'browser.error.'+info.browser+'.'+d.kind);
        return send(200,{ok:true});
      }
      if(route==='/api/assist/apply'){
        const old=profile(),next=assist.plan(old,d.draft,c.ports).profile;
        const {guide:a,...oldConnection}=old,{guide:b,...newConnection}=next;
        if(JSON.stringify(oldConnection)===JSON.stringify(newConnection)){
          if(JSON.stringify(a)!==JSON.stringify(b)){
            save({...db,profiles:db.profiles.map(x=>x.id===next.id?next:x)});session.p=next;epoch=crypto.randomUUID();
            session.screenPending=null;session.screenVerified=null;if(session.bank)session.bank.screenCheck=null;journal.record(next,'project.apply','pass');
          }
          return send(200,state());
        }
        return send(200,await switchTo(next,db.profiles.map(x=>x.id===next.id?next:x)));
      }
      if(route==='/api/project/select'){
        const p=db.profiles.find(x=>x.id===d.id);if(!p)throw Error('未找到项目');
        return send(200,p.id===db.active?state():await switchTo(p,db.profiles));
      }
      if(route==='/api/project/save'){
        const p=structuredClone(d.project);p.id=profile().id;p.commands=profile().commands;p.messageExamples=profile().messageExamples;
        return send(200,await switchTo(validate(p),db.profiles.map(x=>x.id===p.id?p:x)));
      }
      if(route==='/api/project/new'||route==='/api/project/import'){
        if(db.profiles.length>=64)throw Error('项目数已达 64');
        let p;
        if(route.endsWith('import')){if(d.package?.format!=='industrial-bench/1')throw Error('不支持此项目格式');p=structuredClone(d.package.project);}
        else{p=initial();p.name=d.name||'新项目';}
        const newId=crypto.randomUUID().slice(0,8);p.id=newId;
        if(route.endsWith('new')){p.device='SIM_'+newId.toUpperCase();p.prefix='/sim/'+p.device+'/';}
        if(d.device){p.device=d.device;if(d.prefix)p.prefix=d.prefix;}
        return send(200,await switchTo(validate(p),[...db.profiles,p]));
      }
      users++;
      try{
        const p=profile();let result;
        if(route==='/api/assist/recognise')result=assist.recognise(d.files);
        else if(route==='/api/assist/path')result=await inspectPath(d.path);
        else if(route==='/api/assist/inventory')result=await inventory(root);
        else if(route==='/api/assist/current')result=assist.currentPlan(p,c.ports);
        else if(route==='/api/assist/plan')result=assist.plan(p,d.draft,c.ports);
        else if(route==='/api/assist/points')result={csv:csv(assist.plan(p,d.draft,c.ports).profile)};
        else if(route==='/api/assist/probe'||route==='/api/assist/read'){
          diagnosticProfile=assist.plan(p,d.draft,c.ports).profile;
          result=route.endsWith('/read')?await assist.readKnown(diagnosticProfile,c.ports,d.address):await assist.probe(diagnosticProfile,c.ports);
        }
        else if(route==='/api/assist/check')result=await checkSession(session,d.topicId,d.query===true);
        else if(route==='/api/assist/screen-start')result=await startScreen(session);
        else if(route==='/api/assist/screen-confirm')result=await confirmScreen(session,d);
        else if(route==='/api/protocol/import'||route==='/api/protocol/delete-example'){
          let update;
          if(route.endsWith('/import')){
            const {next,added,samples,skipped}=merge(p,d.items);update=next;result={added,samples,skipped};
          }else{
            const rows=p.messageExamples||[];
            if(!rows.some(x=>x.id===d.id))throw Error('未找到该样例');
            update={...p,messageExamples:rows.filter(x=>x.id!==d.id)};result={message:'样例已删除'};
          }
          save({...db,profiles:db.profiles.map(x=>x.id===p.id?update:x)});session.p=update;
        }
        else if(route==='/api/button/save'||route==='/api/button/delete'){
          const list=p.commands.slice();
          if(route.endsWith('save')){const btn=command({...d.button,id:d.button.id||crypto.randomUUID().slice(0,12)}),idx=list.findIndex(x=>x.id===btn.id);if(idx<0)list.push(btn);else list[idx]=btn;}
          else{const idx=list.findIndex(x=>x.id===d.id);if(idx<0)throw Error('未找到按钮');list.splice(idx,1);}
          const update=validate({...p,commands:list});save({...db,profiles:db.profiles.map(x=>x.id===p.id?update:x)});session.p=update;result={message:'按钮库已保存'};
        }else if(route==='/api/button/preview'||route==='/api/button/send'){
          const saved=p.commands.find(b=>b.id===d.id);const btn=route.endsWith('preview')&&d.button?command(d.button):saved;
          if(!btn)throw Error('按钮不存在，请先保存');
          const x=expand(btn,p,session.model?.state()||session.lastState,d.values||{});
          result=route.endsWith('preview')?x:await session.send(x);
        }else if(route==='/api/physical')result=await session.physical(d.key,d.action);
        else if(route==='/api/hmi')result=await session.hmi(d.action);
        else if(route==='/api/probe'){await session.refresh();result=session.links();}
        else if(route==='/api/reconcile')result=await session.reconcile();
        else if(route==='/api/link'){session.setLink(d.key,d.value);result=session.links();}
        else if(route==='/api/advance'){
          if(!session.model||!Number.isInteger(d.seconds)||d.seconds<1||d.seconds>3600)throw Error('快进仅适用于内置模型，范围 1～3600 秒');
          session.model.advance(d.seconds);result={message:'模型时间已推进 '+d.seconds+' 秒'};
        }else return send(404,{error:'未找到入口'});
        if(['/api/physical','/api/hmi','/api/advance'].includes(route))await session.refresh();
        observed(journal,diagnosticProfile||p,route,d,result);
        send(200,result);
      }finally{users--;}
    }catch(e){journal.record(diagnosticProfile||profile(),inputKind(route,d),'fail',reason(e),{operation:operation(route)});send(400,{error:e.message});}
  });
  async function stop(){
    if(closing)return;closing=true;
    for(let i=0;i<50&&users;i++)await new Promise(r=>setTimeout(r,60));
    if(session){journal.record(profile(),'service.stop','info');await session.close();}
    web.closeAllConnections();if(web.listening)await new Promise(r=>web.close(r));
  }
  try{session=await open(profile());await listen(web,c.ports.http);if(!fs.existsSync(file))save(db);
    journal.record(profile(),'service.start','pass');
    return {stop,state,config:c,instance,get session(){return session;}};
  }catch(e){journal.record(profile(),'service.start','fail',reason(e));await stop();throw e;}
}
if(require.main===module){
  const i=process.argv.indexOf('--instance');
  start(rootDir,null,{instance:i<0?undefined:process.argv[i+1],onStop:()=>process.exit(0)}).then(app=>{
    console.log('联调台已就绪 '+app.config.ports.http);process.on('SIGINT',()=>app.stop().then(()=>process.exit(0)));process.on('SIGTERM',()=>app.stop().then(()=>process.exit(0)));
  }).catch(e=>{console.error(e.stack);process.exitCode=1;});
}
module.exports={start,csv};
