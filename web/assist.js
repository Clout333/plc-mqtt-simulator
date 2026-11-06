'use strict';
(() => {
  const el=id=>document.getElementById(id);
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const get=id=>el(id).value,put=(id,value)=>{el(id).value=value;},txt=(id,value)=>{el(id).textContent=value;};
  const s7Labels={bitDB:'位区 DB 号',wordDB:'字区 DB 号',bitByte:'位区起始字节',wordByte:'字区起始字节',rack:'机架',slot:'槽号',localTSAP:'本地 TSAP',remoteTSAP:'远端 TSAP'};
  const offsets={coil:'线圈基址',holding:'保持寄存器基址',start:'启动模拟位',stop:'停止模拟位',reset:'复位模拟位',estop:'急停模拟位'};
  let epoch='',catalog=null,plan=null,checked=null,screen=null,report=null,step=1,working=false,applying=false,dirty=false,catalogRequest='';
  let picked={plc:null,hmi:null,gateway:null},liveCheck=false,lastCheck=0;
  let identifiedPath='',lastSelection='',quickView=false,checkNumber=0;
  const active=()=>!el('assist').hidden;
  function quickEntry(route){
    const example=route==='demo';
    txt('asQuickTitle',example?'先试一次':'检查当前项目');
    txt('asDemo',example?'测试本机示例':'检查已保存的连接');
    txt('asQuickHint',example?'还没有厂家软件？先读取内置 PLC 的状态，再看模拟设备有没有回消息。':'按当前项目已保存的设置，查看 PLC、触摸屏和 MQTT 哪一段已经连通。');
    txt('asQuickScope',example?'只读取状态和记录。':'只检查连接，保留现有设置。');
  }
  function opts(id,pairs){const n=el(id);n.replaceChildren(...pairs.map(([k,title])=>{const o=node('option',title);o.value=k;return o;}));}
  function msg(value='',bad=false){const n=el('asStatus');n.textContent=value;n.className='notice'+(bad?' bad':'');n.hidden=!value;if(value&&bad&&active())n.scrollIntoView({block:'nearest'});}
  function show(n,focus=true){
    step=n;checkNumber++;
    for(let i=1;i<=3;i++){
      el('asStep'+i).hidden=i!==n;
      const stage=el('stage'+i);stage.classList.toggle('done',i<n);
      if(n===i)stage.setAttribute('aria-current','step');else stage.removeAttribute('aria-current');
    }
    if(focus&&active()){const h=el('asStep'+n).querySelector('h3');h?.setAttribute('tabindex','-1');h?.focus({preventScroll:true});el('assist').scrollIntoView({block:'start'});}
  }
  async function api(name,payload={}){
    const identifier=epoch;
    const r=await fetch('/api/assist/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,epoch:identifier})});
    const obj=await r.json();if(!r.ok)throw Error(obj.error||'操作未完成，请重试');
    if(identifier!==epoch)throw Error('已切换项目，请查看当前项目的接入步骤');return obj;
  }
  async function run(fn,caption=''){
    if(working||!catalog)return;
    working=true;el('assist').setAttribute('aria-busy','true');msg(caption);
    const controls=[...el('assist').querySelectorAll('button,input,select')].filter(n=>!n.disabled);
    controls.forEach(n=>n.disabled=true);
    try{await fn();}catch(e){msg(e.message,true);}
    finally{controls.forEach(n=>n.disabled=false);el('assist').removeAttribute('aria-busy');working=false;if(caption&&el('asStatus').textContent===caption)msg();}
  }
  function formVisibility(){
    const route=get('asRoute'),native=route==='plc'||['hmi','gateway'].includes(route)&&el('asWithPlc').checked;
    el('asWithPlcL').hidden=!['hmi','gateway'].includes(route);el('asKitL').hidden=!native;
    el('asWithScreenL').hidden=route!=='gateway';
    el('asHmiL').hidden=route!=='hmi'&&!(route==='gateway'&&el('asWithScreen').checked);
    el('asRoleL').hidden=route!=='hmi';
    const plc=native?(catalog?.kits[get('asKit')]?.name||'我的 PLC 程序'):'内置 PLC';
    const hmi=el('asHmiL').hidden?'模拟触摸屏':(catalog?.screens[get('asHmi')]?.name||'我的触摸屏');
    const owner=route==='gateway'?'我的网关程序':route==='hmi'?(get('asRole')==='mqtt'?'我的触摸屏':'模拟网关'):(s?.project?.owner==='gateway'?'模拟网关':'模拟触摸屏');
    txt('asRouteHint',el('asManual').open||report||s?.project?.guide?'本次使用'+plc+'和'+hmi+'，由'+owner+'收发 MQTT。':'');el('asRouteHint').hidden=!el('asRouteHint').textContent;
  }
  function setup(state,cat){
    catalog=cat;epoch=state.epoch;plan=checked=screen=report=null;picked={plc:null,hmi:null,gateway:null};dirty=false;
    opts('asRoute',Object.entries(cat.routes));opts('asKit',Object.entries(cat.kits).map(([k,v])=>[k,v.name]));
    opts('asHmi',Object.entries(cat.screens).map(([k,v])=>[k,v.name]));opts('asDriver',Object.entries(cat.drivers));
    const last=cat.current;put('asRoute',state.project.guide||last.route!=='demo'?last.route:'plc');put('asKit',last.kit);put('asHmi',last.hmi);
    el('asWithPlc').checked=last.withPlc;el('asWithScreen').checked=last.withScreen;put('asRole',last.route==='hmi'&&!last.screenMqtt?'display':'mqtt');
    const g=state.project.guide||{};
    for(const role of ['plc','hmi','gateway'])if(g[role+'File'])picked[role]={name:g[role+'File']};
    el('asMatches').hidden=true;el('asMatches').replaceChildren();put('asPath','');el('asInventory').replaceChildren();el('asScreenForm').hidden=true;
    identifiedPath='';lastSelection='';quickView=false;el('asManual').open=false;
    el('asTarget').open=false;el('asReadTools').open=false;el('asKnown').removeAttribute('data-driver');el('asKnown').removeAttribute('data-default-value');
    quickEntry(last.route);msg();formVisibility();show(1,false);
  }
  async function open(state){
    if(!state||!active()||applying||catalogRequest===state.epoch)return;
    if(catalog&&epoch===state.epoch){
      if(step===3&&!working&&!liveCheck&&Date.now()-lastCheck>4200){
        liveCheck=true;lastCheck=Date.now();try{await runCheck(false,true);}catch{/* 由主页面提示服务连接状态。 */}finally{liveCheck=false;}
      }
      return;
    }
    const token=state.epoch;catalogRequest=token;epoch=token;catalog=null;
    try{
      const r=await fetch('/api/assist/catalog',{cache:'no-store'});if(!r.ok)throw Error('接入助手未就绪，请确认已启动新版服务。');
      const cat=await r.json();if(s?.epoch===token&&catalogRequest===token)setup(state,cat);
    }catch(e){if(epoch===token)msg(e.message,true);}
    finally{if(catalogRequest===token)catalogRequest='';}
  }
  function selectFile(role,item){
    picked[role]=item;
    if(!item){formVisibility();return;}
    if(role==='plc'&&item.key)put('asKit',item.key);
    if(role==='hmi'&&item.key)put('asHmi',item.key);
    if(picked.gateway){put('asRoute','gateway');el('asWithPlc').checked=!!picked.plc;el('asWithScreen').checked=!!picked.hmi;}
    else if(picked.hmi){put('asRoute','hmi');el('asWithPlc').checked=!!picked.plc;}
    else if(picked.plc)put('asRoute','plc');
    formVisibility();
  }
  function renderFiles(r){
    report=r;picked={plc:null,hmi:null,gateway:null};
    const host=el('asMatches');host.hidden=false;host.replaceChildren();
    if(r.truncated||r.unreadable)host.append(node('p','本次读取了有限范围。缺少目标文件时，请粘贴它的完整路径。','hint'));
    let found=0;
    for(const [role,title] of [['plc','PLC'],['hmi','触摸屏']]){
      const group=r.candidates.filter(v=>v.role===role);if(!group.length)continue;found+=group.length;
      const choose=group.length>1||group[0].confirm;
      const label=node('label',group.length===1?title+' 工程':title+' 工程有 '+group.length+' 份，请选要验证的版本'),list=node('select');list.id='asFile-'+role;
      if(choose){const none=node('option',group.length>1?'请选择工程版本':'请确认工程类型');none.value='';list.append(none);}
      for(const [i,v] of group.entries()){const o=node('option',v.name);o.value=String(i);list.append(o);}
      const hint=node('small',group.length===1?group[0].reason:'各版本将按文件名或相对路径区分。','hint');
      list.onchange=()=>{const item=list.value===''?null:group[Number(list.value)];selectFile(role,item);hint.textContent=item?.reason||'请选择要运行的工程';};
      label.append(list,hint);host.append(label);if(!choose)selectFile(role,group[0]);
    }
    if(r.unclassified.length){
      const label=node('label','通用源码或待确认的工程'),list=node('select');list.id='asFile-unknown';
      for(const name of r.unclassified){const o=node('option',name);o.value=name;list.append(o);}label.append(list);host.append(label);
      const actions=node('div',undefined,'actions');
      for(const [role,title] of [['plc','用作 PLC 程序'],['hmi','用作屏工程'],['gateway','用作网关程序']]){
        const b=node('button',title);b.onclick=()=>{selectFile(role,{name:list.value});el('asManual').open=true;msg('已选用 '+list.value+'，可在下方核对品牌。');};actions.append(b);
      }
      host.append(actions,node('p','请选源码的用途和品牌。ST 等程序块需先在厂家软件中加入工程并编译运行。','hint'));
    }
    if(!found&&!r.unclassified.length)host.append(node('p','没有找到可识别的工程。请换一个文件，或在下方手动选择程序和品牌。','hint'));
    if(r.hmi.length||r.plc.length){
      put('asRoute',r.hmi.length?'hmi':'plc');el('asWithPlc').checked=!!r.plc.length;formVisibility();
    }
    if(r.plc.length||r.hmi.length)el('asManual').open=true;
    formVisibility();
  }
  async function readPath(){
    const path=get('asPath').trim();
    if(!path)throw Error('请粘贴文件或文件夹的完整路径，或点击“选择工程文件”。');
    const result=await api('path',{path});identifiedPath=path;renderFiles(result);
  }
  async function localFiles(fileList){
    const files=Array.from(fileList);if(!files.length)return;
    if(files.length>160)throw Error('选择的文件超过 160 份，请缩小到工程文件或使用项目子目录。');
    const meta=[];
    for(const f of files){
      let vendor='';
      if(/\.(xml|project|mcgs)$/i.test(f.name)){
        const data=new Uint8Array(await f.slice(0,24576).arrayBuffer());
        let text='';try{text=BenchText.decode(data,f.size>data.length);}catch{/* 部分厂家的 .project 为二进制，仍可按扩展名手动选择。 */}
        vendor=[...text.matchAll(/\b(?:companyName|productName|vendor|manufacturer)\s*=\s*["']([^"'<>\r\n]{1,90})["']/gi)].slice(0,6).map(v=>v[1]).join(' ').slice(0,180);
      }
      meta.push({name:f.name,vendor});
    }
    const result=await api('recognise',{files:meta});put('asPath','');identifiedPath='';renderFiles(result);
  }
  function selection(){
    const route=get('asRoute');
    if(route!=='demo'&&report){
      if(!report.candidates.length&&!Object.values(picked).some(Boolean)&&!el('asManual').open){
        throw Error(report.unclassified.length?'请为源码选择用途，或展开“手动选择程序或品牌”。':'请换一个工程文件，或展开“手动选择程序或品牌”。');
      }
      for(const [role,needed] of [['plc',route==='plc'||['hmi','gateway'].includes(route)&&el('asWithPlc').checked],['hmi',route==='hmi'||route==='gateway'&&el('asWithScreen').checked]]){
        const choices=report.candidates.filter(v=>v.role===role);
        if(needed&&!picked[role]&&(choices.length>1||choices[0]?.confirm))throw Error(choices.length>1?'目录里有多个'+(role==='plc'?' PLC ':'触摸屏')+'工程，请先选择具体版本。':'请先确认文件的厂商和工程类型。');
      }
    }
    const d={route,kit:get('asKit'),hmi:get('asHmi'),withPlc:el('asWithPlc').checked,withScreen:el('asWithScreen').checked,screenMqtt:get('asRole')==='mqtt'};
    for(const role of ['plc','hmi','gateway'])if(picked[role])d[role+'File']=picked[role].name;
    return d;
  }
  function numberField(key,label,value,group){
    const l=node('label',label),input=node('input');input.type='number';input.step='1';input.min='0';input.id='asN-'+key;input.value=value;l.append(input);group.append(l);
  }
  function nativeFields(p){
    const n=p.native;put('asDriver',n.driver);put('asHost',p.host);put('asPort',p.port);put('asUnit',p.unit);
    el('asUnitL').hidden=n.driver!=='modbus';el('asS7').hidden=n.driver!=='s7';
    el('asOffsets').replaceChildren();for(const [key,label] of Object.entries(offsets))numberField(key,label,p.physical[key]??p[key],el('asOffsets'));
    el('asS7').replaceChildren();for(const [key,label] of Object.entries(s7Labels))numberField(key,label,n[key],el('asS7'));
  }
  function numeric(id){const v=get(id);if(!v.trim()||!Number.isInteger(Number(v)))throw Error('请填写完整的端口或地址数字');return Number(v);}
  function edited(){
    const d=selection();if(!plan?.native)return d;
    Object.assign(d,{driver:get('asDriver'),host:get('asHost').trim(),port:numeric('asPort'),unit:numeric('asUnit'),coil:numeric('asN-coil'),holding:numeric('asN-holding'),physical:{}});
    for(const k of ['start','stop','reset','estop'])d.physical[k]=numeric('asN-'+k);
    if(d.driver==='s7'){d.s7={};for(const k of Object.keys(s7Labels))d.s7[k]=numeric('asN-'+k);}
    return d;
  }
  function connectionSheet(){
    if(!plan)return '';
    const rows=[s.project.name+' · 工程接入单',Object.values(plan.scope).join(' / '),''];
    for(const row of plan.bindings)rows.push('['+row.section+'] '+row.label+'　'+row.value);
    for(const block of plan.steps){rows.push('',block.title);block.items.forEach((v,i)=>rows.push((i+1)+'. '+v));}
    if(plan.sample)rows.push('','MQTT 报文示例',sampleText(plan.sample));
    if(checked){rows.push('','检查时间　'+new Date(checked.checked).toLocaleString('zh-CN'));for(const r of checked.items)rows.push(statusNames[r.status]+'　'+r.title+'　'+r.detail+(r.next?'　'+r.next:''));}
    return rows.join('\r\n');
  }
  async function copy(text){
    try{await navigator.clipboard.writeText(text);msg('已复制');}
    catch{const n=node('textarea');n.value=text;el('assist').append(n);n.select();const ok=document.execCommand('copy');n.remove();if(!ok)throw Error('浏览器未允许复制，请选中文字或导出接入单');msg('已复制');}
  }
  function download(name,content,mime){
    const a=node('a'),url=URL.createObjectURL(new Blob([content],{type:mime+';charset=utf-8'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function sampleText(sample){
    let body=sample.payload;try{body=JSON.stringify(JSON.parse(body),null,2);}catch{}
    return [sample.name+(sample.template?' · 参数模板':' · 展开示例'),'发布主题　'+sample.topic,body,
      ...(sample.reply?['回执主题　'+sample.reply,'关联字段　'+sample.requestKey+' → '+sample.replyKey]:[])].join('\n');
  }
  function drawPlan(next){
    plan=next;checked=null;dirty=false;
    const scope=el('asScope');scope.replaceChildren();
    for(const [k,title] of [['plc','PLC'],['screen','触摸屏'],['mqtt','设备端 MQTT'],['platform','平台']]){const x=node('div');x.append(node('small',title),node('strong',next.scope[k]));scope.append(x);}
    const instructions=el('asInstructions');instructions.replaceChildren();
    for(const block of next.steps){const h=node('h4',block.title),list=node('ol');block.items.forEach(t=>list.append(node('li',t)));instructions.append(h,list);}
    const dt=el('asBindings');dt.replaceChildren();
    if(!next.bindings.length)dt.append(node('p','软件示例已带好全部连接参数，可以直接检查。','as-next'));
    let prev='';
    for(const item of next.bindings){if(item.section!==prev){dt.append(node('h4',item.section));prev=item.section;}
      const r=node('div',undefined,'as-binding');r.append(node('span',item.label));const b=node('button',item.value,'as-value');b.title='复制 '+item.label;b.onclick=()=>run(()=>copy(item.value));r.append(b);dt.append(r);}
    el('asTarget').hidden=el('asReadTools').hidden=!next.native;
    if(next.native){
      nativeFields(next.profile);const driver=next.profile.native.driver,known=el('asKnown');
      const suggested=next.bindings.find(b=>b.label.includes('期望 1'))?.value||'';
      if(known.dataset.driver!==driver||!known.value||known.value===known.dataset.defaultValue)known.value=suggested;
      known.dataset.driver=driver;known.dataset.defaultValue=suggested;
      txt('asKnownHint',({s7:'可填 DB101.DBW0 或 DB100.DBX1.0。S7-200 也可填 VW100 或 V10.0。',mc3e:'可填 M8 或 D100。选一个能在 GX 仿真窗口看到的变量核对。',modbus:'可填 HR 0 或 C 8，使用保持寄存器或线圈的零基地址。'})[driver]);
    }
    el('asExample').hidden=!next.sample;txt('asExampleText',next.sample?sampleText(next.sample):'');
    txt('asBindingsHint',next.bindings.length?'点击数值即可复制到厂家软件。':'本机示例使用内置参数。');
    if(!next.native)el('asTarget').open=false;
  }
  async function makePlan(){
    if(get('asPath').trim()&&get('asPath').trim()!==identifiedPath)await readPath();
    if(!report&&!el('asManual').open&&!s.project.guide){
      el('asManual').open=true;
      throw Error('请选择要测试的程序和品牌，再点“查看连接步骤”。也可以直接选择工程文件。');
    }
    const draft=selection(),selectionKey=JSON.stringify(draft);
    if(quickView||!plan||lastSelection!==selectionKey){
      drawPlan(await api('plan',{draft}));el('asTarget').open=false;el('asReadTools').open=false;
    }
    lastSelection=selectionKey;quickView=false;el('asProbeRows').replaceChildren();show(2);
  }
  async function prepareSheet(){
    if(dirty)drawPlan(await api('plan',{draft:edited()}));
  }
  const statusNames={pass:'已核对',fail:'需处理',wait:'待验证',skip:'未配置'};
  function renderRows(id,rows){
    const box=el(id);box.replaceChildren();
    for(const r of rows){const v=node('div',undefined,'as-row '+r.status),head=node('div',undefined,'as-rowhead');head.append(node('strong',r.title),node('span',statusNames[r.status]));v.append(head,node('p',r.detail));if(r.next)v.append(node('small',r.next));box.append(v);}
  }
  async function runCheck(query,background=false){
    const number=++checkNumber,before=get('asTopic'),x=await api('check',{topicId:before,query});
    if(!active()||step!==3||number!==checkNumber||background&&(working||before!==get('asTopic')))return;
    const sameMenu=checked&&JSON.stringify(x.topics)===JSON.stringify(checked.topics);checked=x;lastCheck=Date.now();
    if(!sameMenu||el('asTopic').options.length!==x.topics.length)opts('asTopic',x.topics.map(t=>[t.id,t.name+' · '+t.topic]));put('asTopic',x.selected);el('asTopicL').hidden=x.topics.length<2;
    renderRows('asChecks',x.items);el('asScreenBox').hidden=!x.screen;
    const missing=x.items.find(r=>r.status==='fail')||x.items.find(r=>r.status==='wait');
    const skipped=x.items.some(row=>row.status==='skip'),rejected=x.items.some(row=>row.rejected);
    txt('asOutcome',missing?missing.title+(missing.status==='fail'?'需要处理':'待确认'):skipped?'已检查可用连接':rejected?'通信已通，设备拒绝了请求':'连接检查通过');
    txt('asNext',missing?(missing.next||missing.detail):skipped?'已核对当前可检查的项目。要验证设备回复，请先在物联网按钮中填写回执主题。':rejected?'请打开报文记录，查看设备回复的拒绝原因。':'已读到 PLC 状态并收到设备回复，可以去联调台测试按钮。');
    const action=el('asAction');
    action.hidden=missing?.key==='screen';
    if(!action.hidden){
      const route=missing?.key==='reply'||(!missing&&skipped)||missing?.key==='topic'&&!x.topics.length?'buttons':missing?'settings':'console';
      action.textContent=({buttons:'打开物联网按钮',settings:'查看连接设置',console:'进入联调台'})[route];
      action.onclick=()=>{if(route==='settings'&&!quickView){show(2);if(plan?.native&&missing?.key==='plc')el('asTarget').open=true;}else chooseView(route==='settings'?'connect':route);};
    }
    txt('asCheckTime','最近一次检查　'+new Date(x.checked).toLocaleTimeString('zh-CN')+'　·　'+x.items.filter(r=>r.status==='pass').length+' 项已核对');
  }
  el('asChoose').onclick=()=>el('asFiles').click();
  el('asFiles').onchange=e=>{const files=Array.from(e.target.files);e.target.value='';run(()=>localFiles(files));};
  const drop=el('asDrop');drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};drop.ondragleave=()=>drop.classList.remove('over');
  drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');const files=[...e.dataTransfer.files];run(()=>localFiles(files));};
  el('asRead').onclick=()=>run(readPath,'正在识别工程…');
  el('asPath').oninput=()=>{
    if(get('asPath').trim()===identifiedPath)return;
    identifiedPath='';report=null;picked={plc:null,hmi:null,gateway:null};
    el('asMatches').replaceChildren();el('asMatches').hidden=true;formVisibility();msg();
  };
  el('asManual').ontoggle=()=>{if(catalog)formVisibility();};
  el('asPath').onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();el('asRead').click();}};
  el('asDiscover').onclick=()=>run(async()=>{
    const n=el('asInventory');n.textContent='正在检查本机…';const r=await api('inventory');n.replaceChildren();
    for(const item of r.items){const b=node('button',item.title+' · '+(item.running?'运行中':'已找到'));b.title='选择这个品牌';
      b.onclick=()=>{put(item.role==='plc'?'asKit':'asHmi',item.key);if(item.role==='hmi'){put('asRoute','hmi');}else if(!['hmi','gateway'].includes(get('asRoute')))put('asRoute','plc');else el('asWithPlc').checked=true;formVisibility();msg('已选择 '+item.title);};n.append(b);
      if(item.ports?.length)n.append(node('small','该进程监听 '+item.ports.join('、')+'；请核对通信端口。','hint'));}
    n.append(node('p',(r.items.length?'':'没有在常用位置找到对应软件。')+r.note,'hint'));
  });
  ['asRoute','asWithPlc','asWithScreen','asRole','asKit','asHmi'].forEach(k=>el(k).onchange=formVisibility);
  el('asPlan').onclick=()=>run(makePlan,'正在准备连接步骤…');
  function beginChecks(quick){
    quickView=quick;screen=null;checked=null;el('asChecks').replaceChildren();el('asScreenBox').hidden=true;
    el('asScreenForm').hidden=true;el('asAction').hidden=true;el('asTopicL').hidden=true;opts('asTopic',[]);
    txt('asOutcome','正在检查连接');txt('asNext','');txt('asCheckTime','');
    txt('asBack2',quick?'返回选择工程':'返回连接设置');show(3);
  }
  el('asDemo').onclick=()=>run(async()=>{
    drawPlan(await api('current'));beginChecks(true);await runCheck(true);
  },'正在读取 PLC 状态并检查 MQTT 消息…');
  el('asBack1').onclick=()=>{checked=null;msg();show(1);};el('asBack2').onclick=()=>{msg();show(quickView?1:2);};
  el('asCopy').onclick=()=>run(async()=>{await prepareSheet();return copy(connectionSheet());});
  el('asPoints').onclick=()=>run(async()=>{await prepareSheet();const v=await api('points',{draft:edited()});download('本方案PLC点表.csv',v.csv,'text/csv');});
  el('asTarget').oninput=()=>{dirty=true;checked=null;el('asProbeRows').replaceChildren();txt('asBindingsHint','参数已修改，复制、下载或保存时会使用新值。');};
  el('asDriver').onchange=async()=>run(async()=>{
    const old=plan.profile,driver=get('asDriver'),draft=edited();
    const previousDriver=old.native.driver;
    if(draft.port===catalog.ports[previousDriver])delete draft.port;
    if(driver==='s7'&&previousDriver!=='s7')delete draft.s7;
    const next=await api('plan',{draft});drawPlan(next);el('asTarget').open=true;
  });
  el('asProbe').onclick=()=>run(async()=>{const d=edited();drawPlan(await api('plan',{draft:d}));const results=await api('probe',{draft:d});renderRows('asProbeRows',results);},'正在读取仿真端的测试点…');
  el('asReadKnown').onclick=()=>run(async()=>{const d=edited(),address=get('asKnown');drawPlan(await api('plan',{draft:d}));const result=await api('read',{draft:d,address});renderRows('asProbeRows',[result]);},'正在读取这个变量…');
  el('asApply').onclick=()=>run(async()=>{
    await prepareSheet();
    applying=true;
    try{
      await changeProject(async()=>{
        const next=await api('apply',{draft:edited()});
        epoch=next.epoch;
        return next;
      });
      quickEntry(plan.route);beginChecks(false);await runCheck(true);
    }finally{applying=false;}
  },'正在应用本机连接并检查…');
  el('asCheck').onclick=()=>run(()=>runCheck(true));el('asTopic').onchange=()=>run(()=>runCheck(false));
  el('asScreenStart').onclick=()=>run(async()=>{
    screen=await api('screen-start');el('asScreenForm').hidden=false;put('asScreenNumber','');
    txt('asScreenLabel',screen.kind==='model'?'从厂商屏运行画面读取四位数。保持寄存器零基 '+(s.project.holding+80)+'，一基偏移号 '+(s.project.holding+81)+'，5 分钟内有效。':'读取厂商画面上的 PLC 启动代次，5 分钟内填写。此项记为人工对照。');
    msg('已开始验屏，请查看厂家仿真画面。');
  });
  el('asConfirm').onclick=()=>run(async()=>{if(!screen)throw Error('请先开始验屏');const v=await api('screen-confirm',{id:screen.id,value:get('asScreenNumber')});el('asScreenForm').hidden=true;await runCheck(false);msg(v.message);});
  el('asExport').onclick=()=>{
    if(!checked){msg('还没有检查结果，请先点“重新检查”。',true);return;}
    download('工程接入单与检查结果.txt','\uFEFF'+connectionSheet(),'text/plain');
  };
  window.BenchAssistant={open};if(typeof s!=='undefined'&&s&&active())open(s);
})();
