'use strict';
const $=id=>document.getElementById(id);
const physicalNames={start:'启动',stop:'停止',reset:'复位',estop:'急停'};
const pending=new Set(),views=['console','assist','buttons','connect','frames','diagnostics'];
let s,editId=null,editingEpoch='',buttonSignature='',frameSignature='',pollNo=0,requestNo=0,loading=false,noticeTimer,askResolver;
function element(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function setText(id,v){$(id).textContent=v;}
function notice(msg,bad=false){clearTimeout(noticeTimer);const n=$('notice');n.textContent=msg;n.className='notice'+(bad?' bad':'');n.hidden=false;noticeTimer=setTimeout(()=>{n.hidden=true;},bad?12000:6000);}
async function post(url,data={}){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,epoch:s?.epoch})});
  const body=await r.json();if(!r.ok)throw Error(body.error||'操作失败');return body;
}
async function act(key,fn){
  if(pending.has(key))return;pending.add(key);try{await fn();}catch(e){notice(e.message,true);}finally{pending.delete(key);await refresh();}
}
function chooseView(v){
  if(!views.includes(v))v='console';
  if(location.hash!=='#'+v){clearTimeout(noticeTimer);$('notice').hidden=true;}
  for(const id of views)$(id).hidden=id!==v;
  document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===v)));
  if(location.hash!=='#'+v)history.replaceState(null,'','#'+v);
  if(v==='assist'&&s)window.BenchAssistant?.open(s);
  if(v==='diagnostics')window.BenchDiagnostics?.open();
}
function options(select,entries){
  select.replaceChildren(...entries.map(([v,t])=>{const o=element('option',t);o.value=v;return o;}));
}
const nativeDefaults={driver:'modbus',bitDB:100,wordDB:101,bitByte:0,wordByte:0,rack:0,slot:1,localTSAP:0,remoteTSAP:0};
const s7labels={bitDB:'位区 DB 号',wordDB:'字区 DB 号',bitByte:'位区起始字节',wordByte:'字区起始字节',rack:'机架',slot:'槽号',localTSAP:'本地 TSAP',remoteTSAP:'远端 TSAP'};
function enableNativeFields(){const native=$('pSource').value==='native';$('pHost').disabled=$('pPort').disabled=$('pDriver').disabled=!native;$('s7options').hidden=!native||$('pDriver').value!=='s7';}
function brandAdvice(){setText('brandAdvice',s.brands.plc[$('pPlc').value]?.[1]+' '+s.brands.hmi[$('pHmi').value]?.[1]);}
function projectFields(){
  const p=s.project;
  options($('pPlc'),Object.entries(s.brands.plc).map(([v,x])=>[v,x[0]]));options($('pHmi'),Object.entries(s.brands.hmi).map(([v,x])=>[v,x[0]]));
  const bind={Name:'name',Mode:'startMode',Plc:'plc',Hmi:'hmi',Source:'source',Owner:'owner',Receiver:'receiver',Device:'device',Prefix:'prefix',Host:'host',Port:'port',Unit:'unit',Coil:'coil',Holding:'holding',Seconds:'seconds'};
  for(const [k,v] of Object.entries(bind))$('p'+k).value=p[v];
  const rows=Object.keys(physicalNames).map(k=>{
    const tr=element('tr'),a=element('td',physicalNames[k]),b=element('td'),c=element('td'),check=element('input'),addr=element('input');
    check.type='checkbox';check.id='use-'+k;check.checked=p.buttons[k];check.setAttribute('aria-label','启用'+physicalNames[k]);
    addr.type='number';addr.id='addr-'+k;addr.min='0';addr.max='65535';addr.value=p.physical[k];addr.setAttribute('aria-label',physicalNames[k]+'线圈地址');
    b.append(check);c.append(addr);tr.append(a,b,c);return tr;
  });
  const native={...nativeDefaults,...p.native};$('pDriver').value=native.driver;
  $('s7fields').replaceChildren(...Object.entries(s7labels).map(([k,title])=>{const label=element('label',title),input=element('input');input.type='number';input.id='s7-'+k;input.min='0';input.max='65535';input.value=native[k];label.append(input);return label;}));
  $('physicalMap').replaceChildren(...rows);enableNativeFields();brandAdvice();
  setText('addresses','本地 Broker 127.0.0.1:'+s.ports.mqtt+' · '+(p.source==='model'?'模型 Modbus TCP 127.0.0.1:'+s.ports.modbus:'目标 '+native.driver.toUpperCase()+' '+p.host+':'+p.port)+' · 导出的点表包含当前驱动的地址。');
}
function projectValue(){
  const p=structuredClone(s.project);
  for(const [key,name] of Object.entries({name:'Name',plc:'Plc',hmi:'Hmi',source:'Source',owner:'Owner',receiver:'Receiver',device:'Device',prefix:'Prefix',startMode:'Mode',host:'Host'}))p[key]=$('p'+name).value.trim();
  for(const [key,name] of Object.entries({unit:'Unit',coil:'Coil',holding:'Holding',port:'Port',seconds:'Seconds'}))p[key]=Number($('p'+name).value);
  for(const k of Object.keys(physicalNames)){p.buttons[k]=$('use-'+k).checked;p.physical[k]=Number($('addr-'+k).value);}
  p.native={driver:$('pDriver').value};for(const k of Object.keys(s7labels))p.native[k]=Number($('s7-'+k).value);
  return p;
}
function blank(){return {id:'',name:'',topic:'{{prefix}}command',format:'json',payload:JSON.stringify({deviceId:'{{device}}',seq:'{{seq}}',timestamp:'{{timestamp}}',action:'query',params:{}},null,2),qos:1,replyTopic:'{{prefix}}reply',requestKey:'seq',replyKey:'seq',timeout:3};}
const btnFields={Name:'name',Topic:'topic',Format:'format',Payload:'payload',Qos:'qos',Reply:'replyTopic',ReqKey:'requestKey',RepKey:'replyKey',Timeout:'timeout'};
function edit(c){
  editId=c.id||null;for(const [suffix,key] of Object.entries(btnFields))$('btn'+suffix).value=c[key];
  $('btnValues').value='{}';$('deleteButton').disabled=!editId;$('previewBox').hidden=true;setText('editorTitle',editId?'编辑按钮':'新增按钮');drawButtons();
}
function buttonValue(){const x={id:editId||''};for(const [suffix,key] of Object.entries(btnFields))x[key]=$('btn'+suffix).value;
  x.qos=Number(x.qos);x.timeout=Number(x.timeout);x.name=x.name.trim();return x;}
function params(){const x=JSON.parse($('btnValues').value||'{}');if(!x||Array.isArray(x)||typeof x!=='object')throw Error('本次发送参数须为 JSON 对象');return x;}
function drawButtons(){
  buttonSignature=JSON.stringify(s.project.commands);
  const list=s.project.commands;const manage=[],send=[];
  for(const c of list){
    const row=element('button',undefined,'buttonRow'+(editId===c.id?' selected':''));row.type='button';row.append(element('span',c.name),element('small','QoS '+c.qos));row.onclick=()=>edit(c);manage.push(row);
    const b=element('button',c.name);b.dataset.command=c.id;b.onclick=()=>act('mqtt-'+c.id,async()=>{
      const built=new Set(['device','prefix','timestamp','seq','seconds','task','activeTask']);
      const parameters=[...new Set([...((c.topic+' '+c.replyTopic+' '+c.payload).matchAll(/\{\{([A-Za-z]\w*)\}\}/g))].map(x=>x[1]).filter(k=>!built.has(k)))];
      let values={};
      if(parameters.length){const input=await ask('输入本次报文参数','JSON 参数对象',JSON.stringify(Object.fromEntries(parameters.map(k=>[k,'']))));if(input===null)return;values=JSON.parse(input);}
      await transmit(c.id,values);});send.push(b);
  }
  $('buttonList').replaceChildren(...(manage.length?manage:[element('p','暂无按钮，请新增。','hint')]));
  $('mqttActions').replaceChildren(...(send.length?send:[element('p','请在按钮库中添加本项目的物联网操作。','hint')]));
}
function renderRows(node,list){
  const rows=list.map(f=>{const tr=element('tr');tr.append(element('td',new Date(f.time).toLocaleTimeString('zh-CN',{hour12:false})),element('td',f.flow),element('td',f.topic,'code'),element('td',f.seq||'—','code'));
    const td=element('td',undefined,'actionsCell'),b=element('button','查看','textBtn');b.onclick=()=>act('detail',async()=>{
      const r=await fetch('/api/frame?id='+encodeURIComponent(f.id)),v=await r.json();if(!r.ok)throw Error(v.error);
      setText('dialogTitle','报文详情');setText('dialogMeta',v.topic+' · QoS '+v.qos+' · '+v.client+' · '+new Date(v.time).toLocaleString());
      setText('dialogBody',v.raw);$('detail').showModal();});
    td.append(b);tr.append(td);return tr;});
  if(!rows.length){const tr=element('tr'),td=element('td','暂无匹配报文','muted');td.colSpan=5;tr.append(td);rows.push(tr);}
  node.replaceChildren(...rows);
}
function frames(){
  const filter=$('filter').value.toLowerCase();
  const signature=[s.epoch,s.frames[0]?.id,s.frames.length,filter].join('|');if(signature===frameSignature)return;frameSignature=signature;
  renderRows($('recentRows'),s.frames.slice(0,4));renderRows($('allRows'),s.frames.filter(f=>[f.topic,f.seq,f.flow,f.client].join(' ').toLowerCase().includes(filter)));
}
function paint(force=false){
  window.BenchDiagnostics?.ready(s.epoch);
  if(!document.getElementById('assist').hidden)window.BenchAssistant?.open(s);
  const p=s.project,l=s.links,v=s.plc;
  if(force||editingEpoch!==s.epoch){
    editingEpoch=s.epoch;options($('projectChoice'),s.projects.map(x=>[x.id,x.name]));$('projectChoice').value=p.id;
    setText('projectTitle',p.name);setText('routeText',(p.source==='model'?'内置 PLC 模型':'外部 PLC 仿真器')+'  /  '+(p.owner==='hmi'?'触摸屏接入 MQTT':'网关模块接入 MQTT'));
    projectFields();edit(p.commands[0]||blank());$('receipt').hidden=true;
    setText('screenBrand',s.brands.hmi[p.hmi][0]+' · '+(p.receiver==='external'?'外部设备操作':'模拟屏'));
    setText('topicHint',p.prefix+'  ·  '+(p.receiver==='builtin'?'内置设备端':'等待项目自己的设备端'));
    setText('footerPorts','本机 127.0.0.1　·　网页 '+s.ports.http+'　·　MQTT '+s.ports.mqtt+'　·　'+(p.source==='model'?'模型 Modbus '+s.ports.modbus:'目标 PLC '+p.host+':'+p.port));
  }
  const lamp=(id,ok)=>$(id).classList.toggle('good',!!ok);lamp('plcLamp',l.plc);lamp('mqttLamp',l.broker);lamp('ownerLamp',l.device&&l.matched);
  if(buttonSignature!==JSON.stringify(p.commands))drawButtons();
  $('ownerLink').title=l.subscriptions.join('\n');
  setText('plcLink',l.plc?'通信正常':'未接通');$('plcLink').title=l.plcError;
  setText('mqttLink',l.platform?'就绪':'连接中');setText('ownerName',p.owner==='hmi'?'触摸屏 MQTT':'网关 MQTT');setText('ownerLink',l.device?(l.matched?'已订阅':l.subscribed?'已订阅其他主题':'已连接，待订阅'):'等待设备');
  setText('serverLink','本机服务在线');$('serverLink').classList.remove('offline');
  for(const k of Object.keys(physicalNames))$('key-'+k).disabled=!p.buttons[k]||!l.plc;
  setText('note-start',!p.buttons.start?'项目停用':p.startMode==='enable'?'只给许可':'直接启动');
  setText('note-stop',p.buttons.stop?'结束任务':'项目停用');setText('note-reset',p.buttons.reset?'清除故障':'项目停用');
  $('release').disabled=!p.buttons.estop||!l.plc;setText('release',p.buttons.estop?'释放急停':'项目停用');$('key-estop').classList.toggle('down',!!v?.estop);
  setText('permit',!v?'未知':p.startMode==='direct'||!p.buttons.start?'无需授权':v.enabled?'已使能':'待使能');
  setText('emergency',!v?'未知':v.estop?'急停按下':'已释放');setText('fault',!v?'未知':v.fault?'待复位':'正常');
  setText('phase',v?['','待机','准备中','作业中','结束处理'][v.running]:'通信中断');setText('progressValue',v?v.progress+'%':'—');$('progress').value=v?.progress||0;
  setText('currentTask',v?v.task_seq?'任务 '+v.task_seq+'　·　'+v.elapsed_seconds+' / '+v.target_seconds+' 秒':'当前无任务':l.plcError||'等待 PLC');
  document.querySelectorAll('[data-hmi]').forEach(b=>{b.disabled=p.receiver==='external'||!l.screenOn||!v||(b.dataset.hmi==='start'&&(v.busy||v.fault||v.estop||v.maintenance||p.startMode==='enable'&&p.buttons.start&&!v.enabled))||(b.dataset.hmi==='stop'&&!v.busy);});
  $('advance').disabled=p.source!=='model'||!v?.busy;$('testScreen').checked=l.screenOn;$('testScreen').disabled=p.receiver==='external';$('testMqtt').checked=l.mqttAllowed;$('testPlc').checked=l.plcAllowed;frames();
}
async function refresh(force=false){
  const n=++requestNo;
  try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw Error('服务正在切换或未连接');const next=await r.json();if(n<pollNo)return;pollNo=n;s=next;paint(force);}
  catch(e){setText('serverLink','服务未就绪');$('serverLink').classList.add('offline');if(!s)setText('projectTitle','等待本机服务');}
}
function ask(title,label,defaultValue){
  if(askResolver)return Promise.resolve(null);
  setText('askTitle',title);setText('askLabel',label);$('askLabel').htmlFor='askInput';$('askInput').value=defaultValue;setText('askError','');
  $('inputDialog').showModal();$('askInput').select();return new Promise(resolve=>{askResolver=resolve;});
}
function doneAsk(v){$('inputDialog').close();const resolve=askResolver;askResolver=null;resolve?.(v);}
$('askForm').onsubmit=e=>{e.preventDefault();doneAsk($('askInput').value.trim());};$('askCancel').onclick=()=>doneAsk(null);$('inputDialog').oncancel=e=>{e.preventDefault();doneAsk(null);};
async function transmit(id,values){
  const out=$('receipt');out.hidden=false;out.className='receipt warn';out.textContent='正在发送并等待回执…';
  let r;try{r=await post('/api/button/send',{id,values});}catch(e){out.className='receipt bad';out.textContent=e.message;throw e;}
  const a=r.response;let t=r.transport+' · ';
  if(a.status==='received'){t+=a.payload?.success===true?'设备已受理':a.payload?.success===false?'设备已拒绝':'收到匹配的业务回执';if(a.payload?.msg)t+=' · '+a.payload.msg;}
  else t+=a.message;
  out.className='receipt'+(a.status==='timeout'||a.payload?.processing?' warn':a.payload?.success===false?' bad':'');out.textContent=t;notice(t,a.payload?.success===false);
  return r;
}
async function saveButton(){
  const c=buttonValue();if(!c.id)c.id='btn-'+crypto.randomUUID().slice(0,8);
  await post('/api/button/save',{button:c});await refresh();edit(s.project.commands.find(x=>x.id===c.id)||c);return c.id;
}
document.querySelectorAll('[data-tab],[data-go]').forEach(b=>b.onclick=()=>chooseView(b.dataset.tab||b.dataset.go));
window.addEventListener('hashchange',()=>chooseView(location.hash.slice(1)));
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>act('key-'+b.dataset.key,async()=>{const r=await post('/api/physical',{key:b.dataset.key,action:b.dataset.key==='estop'?'press':'pulse'});notice(r.message);}));
$('release').onclick=()=>act('release',async()=>notice((await post('/api/physical',{key:'estop',action:'release'})).message));
document.querySelectorAll('[data-hmi]').forEach(b=>b.onclick=()=>act('hmi',async()=>{const r=await post('/api/hmi',{action:b.dataset.hmi});notice(r.message,r.code!==1);}));
$('advance').onclick=()=>act('advance',async()=>notice((await post('/api/advance',{seconds:10})).message));
$('newButton').onclick=()=>edit(blank());$('buttonForm').onsubmit=e=>{e.preventDefault();act('edit',async()=>{await saveButton();notice('已保存到当前项目');});};
$('preview').onclick=()=>act('preview',async()=>{const c=buttonValue();c.id||='preview';const r=await post('/api/button/preview',{button:c,values:params()});$('previewBox').hidden=false;setText('previewBox',r.topic+'\n'+r.raw);});
$('sendEdited').onclick=()=>act('sendEdited',async()=>{const v=params();const id=await saveButton();$('btnValues').value=JSON.stringify(v);const r=await transmit(id,v);$('previewBox').hidden=false;setText('previewBox',r.topic+'\n'+r.raw+'\n\n'+JSON.stringify(r.response,null,2));});
$('deleteButton').onclick=()=>act('delete',async()=>{if(!editId||!confirm('删除本项目的这个 MQTT 按钮？'))return;await post('/api/button/delete',{id:editId});await refresh();edit(s.project.commands[0]||blank());notice('按钮已删除');});
$('projectChoice').onchange=e=>act('switch',async()=>{try{await post('/api/project/select',{id:e.target.value});await refresh(true);}finally{$('projectChoice').value=s.project.id;}});
$('projectForm').onsubmit=e=>{e.preventDefault();act('saveProject',async()=>{await post('/api/project/save',{project:projectValue()});await refresh(true);notice('项目配置已应用');});};
$('pSource').onchange=enableNativeFields;$('pHmi').onchange=$('pPlc').onchange=brandAdvice;
$('pDriver').onchange=()=>{enableNativeFields();$('pPort').value={modbus:15021,s7:102,mc3e:5007}[$('pDriver').value];};
$('probe').onclick=()=>act('probe',async()=>{const l=await post('/api/probe');notice(l.plc?'已读到点表版本、启动代次及当前阶段':l.plcError,!l.plc);});
$('reconcile').onclick=()=>act('reconcile',async()=>notice((await post('/api/reconcile')).message));
$('newProject').onclick=()=>act('new',async()=>{const name=await ask('新建联调项目','项目名称','');if(!name)return;await post('/api/project/new',{name});await refresh(true);notice('新项目已打开');});
$('importProject').onclick=()=>$('importFile').click();$('importFile').onchange=e=>act('import',async()=>{const file=e.target.files[0];e.target.value='';if(!file)return;const pkg=JSON.parse(await file.text());if(!pkg.project?.device)throw Error('缺少项目设备编号');
  let device=pkg.project.device,prefix=pkg.project.prefix;
  if(confirm('是否为导入副本指定新的设备编号和主题前缀？在同一平台保留原项目时请选择“确定”。')){device=await ask('导入项目','新的设备编号',device+'_2');if(!device)return;prefix=await ask('导入项目','该项目的主题前缀','/sim/'+device+'/');if(!prefix)return;}
  await post('/api/project/import',{package:pkg,device,prefix});await refresh(true);notice('导入项目已打开');});
for(const [id,key] of [['testMqtt','mqtt'],['testPlc','plc'],['testScreen','screen']])$(id).onchange=e=>act(id,async()=>{await post('/api/link',{key,value:e.target.checked});notice('连接设置已更新');});
$('filter').oninput=()=>{if(s)frames();};$('closeDetail').onclick=()=>$('detail').close();
chooseView(location.hash.slice(1)||(location.pathname==='/platform'?'buttons':'console'));void refresh();setInterval(async()=>{if(loading||document.hidden)return;loading=true;try{await refresh();}finally{loading=false;}},1100);
