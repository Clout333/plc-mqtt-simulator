'use strict';
const net=require('node:net');
const {validate,expand}=require('./profiles.cjs');
const {defaults,nativeConfig,nativeTag,connectWire}=require('./native.cjs');

const routes={
  plc:'验证 PLC 程序',hmi:'验证触摸屏工程',gateway:'验证网关程序',demo:'先跑通软件示例'
};
const kits={
  haiwell:{name:'海为 PLC',brand:'haiwell',driver:'modbus',steps:[
    '用 HaiwellHappy 打开工程副本，编译后进入厂商提供的模拟运行环境。',
    '核对当前模拟器是否提供外部可读的 Modbus TCP 服务。把项目内部位、字映射到联调点表，填写实际开放的站号和端口。',
    '如果模拟窗口只显示内部变量，可以先在厂家软件验证梯形图，再选内置 PLC 检查屏和报文。']},
  tia:{name:'西门子博途 / S7-1200、1500',brand:'tia',driver:'s7',steps:[
    '在 TIA Portal 编译工程副本，启动与 CPU、软件版本匹配且支持外部通信的仿真实例。',
    '用 S7 驱动时，在测试工程开放相应访问权限，把联调区放在可按绝对地址读取的 DB 中。按实例填写机架、槽号和 DB 号。',
    '用 MB_SERVER 的程序可改选 Modbus TCP。若虚拟 CPU 拥有独立 IP，请通过本机协议桥或端口转发接到本机地址。']},
  smart:{name:'西门子 S7-200 SMART',brand:'s7200',driver:'modbus',steps:[
    '在 STEP 7-Micro/WIN SMART 确认型号和程序使用的通信方式。',
    '已有 Modbus TCP 服务接口时，使用本机能对外通信的运行端或桥，并映射 V/M 区。若使用 S7 访问，在驱动选项选择 S7，按工程填写 TSAP 和 V 区映射。',
    '只有源工程且当前工具无法对外通信时，先在内置模型验证接口，原 PLC 程序留到兼容运行端验证。']},
  classic:{name:'西门子 S7-200 经典型 / PPI',brand:'s7200',driver:'modbus',steps:[
    '用 STEP 7-Micro/WIN 打开工程并核对其模拟方式。PPI 是串行通信接口。',
    '只有已经能读写软件模拟区的本机协议桥，才能把这些位、字转换成 Modbus TCP 或 S7 接口。本台填写桥的本机端口。',
    '目前没有这类软件桥，可返回选择软件示例，先验证屏和 MQTT 报文；经典型程序在其兼容的运行环境中单独验证。']},
  mitsubishi:{name:'三菱 MELSEC',brand:'mitsubishi',driver:'mc3e',steps:[
    '用匹配工程的 GX Works 版本编译测试副本并进入仿真。先确认此运行端能让其他程序通过 TCP 读写模拟区。',
    '在已开放的 SLMP 服务端选择二进制 3E 帧，按运行端实际端口连接。联调点的开关量使用 M，字使用 D。',
    '原程序已经提供 Modbus TCP 服务时可改选该驱动。只有 GX 内部通信时使用可访问该模拟区的本机桥。']},
  inovance:{name:'汇川 PLC',brand:'inovance',driver:'modbus',steps:[
    '用与系列对应的 AutoShop 或 InoProShop 打开和编译副本，在软件里启动模拟。',
    '检查这个运行端有无 Modbus TCP 服务端；若有，按内部位/字设置寄存器映射和站号。仅支持内部模拟的版本需要本机桥。',
    '先读取接口版本、启动代次和阶段。读数吻合后再回联调台测试命令。']},
  generic:{name:'其他 / 已有本机协议桥',brand:'generic',driver:'modbus',steps:[
    '启动已有的 PC 运行程序或协议桥，使它能访问待测程序的内部变量。',
    '把接口版本、启动代次、阶段与请求应答区映射到点表，填写实际使用的本机地址及端口。']}
};
const screens={
  haiwell:{name:'海为云组态',steps:['在 Cloud SCADA Designer 打开 .hwdev 副本，创建或编辑 Modbus TCP 客户端设备。','把数值显示元件绑定到指定的只读保持寄存器；选能访问本机服务的在线模拟（支持的版本可用 F5）。']},
  mcgs:{name:'昆仑通态 MCGS',steps:['在 MCGS 的设备窗口选择适用于该版本的 TCP/IP 通道和 Modbus TCP 客户端驱动，设置远端 IP、端口、设备地址。','添加无符号 16 位只读通道，关联画面数值显示。启动可通信的 PC 运行环境，核对驱动从 0 还是从 1 编号。']},
  weintek:{name:'威纶通 EasyBuilder Pro',steps:['在系统参数的设备列表中添加 MODBUS TCP/IP 或其 Zero-based Addressing 版本，填写 IP、端口和站号。','用数值显示元件选择保持寄存器和无符号 16 位格式，按所选驱动使用零基或一基地址，然后运行在线模拟。']},
  generic:{name:'其他 / 通用屏',steps:['选择能与外部设备通信的 PC 运行方式，把屏设为 Modbus TCP 客户端。','在工程副本放一个 16 位无符号数值显示元件，用下表的只读点验证取数。']}
};
const driverNames={modbus:'Modbus TCP',s7:'西门子 S7（ISO-on-TCP）',mc3e:'三菱 MC / SLMP 二进制 3E'};
const defaultPorts={modbus:502,s7:102,mc3e:5007};
const check=(v,m)=>{if(!v)throw Error(m);};
function infer(p){
  const guide=p.guide||{},driver=nativeConfig(p).driver;
  const kit=guide.kit&&kits[guide.kit]?.brand===p.plc?guide.kit:({tia:'tia',s7200:'smart',haiwell:'haiwell',mitsubishi:'mitsubishi',inovance:'inovance'})[p.plc]||'generic';
  let route=p.receiver==='external'?(p.owner==='gateway'?'gateway':'hmi'):p.source==='native'?'plc':'demo';
  if(guide.route==='hmi'&&p.receiver==='builtin'&&p.owner==='gateway')route='hmi';
  return {route,kit,hmi:p.hmi,withPlc:p.source==='native',withScreen:!!guide.withScreen&&route==='gateway',screenMqtt:p.receiver==='external'&&p.owner==='hmi',driver};
}
function recognise(files){
  check(Array.isArray(files)&&files.length<=160,'每次最多识别 160 份文件说明');
  const found={plc:new Map(),hmi:new Map()},unclassified=[],candidates=[];
  let fileRef='';
  function add(role,key,name,reason,confirm=false){const m=found[role];if(!m.has(key))m.set(key,{key,reason,name,count:0});m.get(key).count++;candidates.push({role,key,name:fileRef||name,reason,confirm});}
  for(const f of files){
    check(f&&typeof f.name==='string'&&f.name.length<=256,'文件名格式有误');
    const name=f.name.replace(/^.*[\\/]/,''),n=name.toLowerCase(),meta=typeof f.vendor==='string'?f.vendor.slice(0,180):'';
    fileRef=typeof f.label==='string'?f.label.slice(0,480):name;
    if(/\.gpc$/.test(n))add('plc','haiwell',name,'海为 PLC 工程扩展名');
    else if(/\.hwdev$/.test(n))add('hmi','haiwell',name,'海为云组态工程扩展名');
    else if(/\.(?:zap|ap)\d{2}(?:_\d+)?$/.test(n))add('plc','tia',name,'TIA Portal 工程可包含 PLC 或 HMI，请确认工程树中有待测 PLC 程序',true);
    else if(/\.smart$/.test(n))add('plc','smart',name,'Micro/WIN SMART 工程扩展名');
    else if(/\.mwp$/.test(n))add('plc','classic',name,'Micro/WIN 工程扩展名');
    else if(/\.(?:gx3|gxw)$/.test(n))add('plc','mitsubishi',name,'GX Works 工程扩展名');
    else if(/\.(?:emtp|cmtp)$/.test(n))add('hmi','weintek',name,'EasyBuilder Pro 工程扩展名');
    else if(/inovance|inoproshop|autoshop|汇川/i.test(meta))add('plc','inovance',name,'工程导出文件中的厂商或软件标识');
    else if(/mcgs|昆仑通态/i.test(meta)||/mcgs|昆仑通态/i.test(n)&&/\.(mcp|mcgs|xml|project)$/.test(n))add('hmi','mcgs',name,'文件中含有 MCGS 标识');
    else if(/weintek|easybuilder/i.test(meta))add('hmi','weintek',name,'工程导出文件中的厂商或软件标识');
    else if(/\.mcp$/.test(n))add('hmi','mcgs',name,'MCP 扩展名由多种软件共用，请确认它确实是 MCGS 工程',true);
    else if(/\.hcp$/.test(n))add('plc','inovance',name,'请确认这份 HCP 文件由汇川编程软件创建',true);
    else if(/\.(st|scl|awl|lad|xml|project|mcp|hcp|s7p|json|js|ts|lua|py|c|cpp|iecst|il|projectarchive)$/.test(n))unclassified.push(fileRef||name);
  }
  return {plc:[...found.plc.values()],hmi:[...found.hmi.values()],unclassified,candidates};
}
function plan(base,d,ports){
  check(d&&Object.hasOwn(routes,d.route)&&Object.hasOwn(kits,d.kit)&&Object.hasOwn(screens,d.hmi),'请选择有效的接入路线和工程系列');
  const p=structuredClone(base),native=d.route==='plc'||(['hmi','gateway'].includes(d.route)&&d.withPlc===true);
  const screen=d.route==='hmi'||(d.route==='gateway'&&d.withScreen===true),gateway=d.route==='gateway',external=gateway||(d.route==='hmi'&&d.screenMqtt!==false);
  const owner=gateway||(d.route==='hmi'&&!external)?'gateway':'hmi';
  p.source=native?'native':'model';p.receiver=external?'external':'builtin';p.owner=owner;
  if(native)p.plc=kits[d.kit].brand;if(screen)p.hmi=d.hmi;
  p.guide={route:d.route,kit:d.kit,withScreen:screen};
  for(const key of ['plcFile','hmiFile','gatewayFile'])if(typeof d[key]==='string'&&d[key].length<=480&&d[key])p.guide[key]=d[key];
  const previous=nativeConfig(base);
  if(native){
    const driver=d.driver||(base.source==='native'&&base.plc===p.plc?previous.driver:kits[d.kit].driver);check(Object.hasOwn(driverNames,driver),'请选择受支持的 PLC 驱动');
    const keep=base.source==='native'&&base.plc===p.plc&&previous.driver===driver;
    let settings=keep?{...previous}:{...defaults,driver};
    if(!keep&&driver==='s7'&&['classic','smart'].includes(d.kit))Object.assign(settings,{bitDB:1,wordDB:1,wordByte:256});
    for(const k of Object.keys(defaults))if(k!=='driver'&&d.s7&&Object.hasOwn(d.s7,k))settings[k]=d.s7[k];
    p.native=settings;p.host=d.host??(keep?base.host:'127.0.0.1');p.port=d.port??(keep?base.port:defaultPorts[driver]);p.unit=d.unit??base.unit;
    for(const k of ['holding','coil'])if(d[k]!==undefined)p[k]=d[k];
    if(d.physical)p.physical={...p.physical,...Object.fromEntries(['start','stop','reset','estop'].filter(k=>Object.hasOwn(d.physical,k)).map(k=>[k,d.physical[k]]))};
    check(![ports.http,ports.mqtt].includes(p.port),'填写的是网页或 MQTT 端口，请使用 PLC 程序自己的端口');
    if(base.source==='model'&&p.port===ports.modbus&&['localhost','127.0.0.1'].includes(p.host))throw Error('该地址正由内置 PLC 使用，请填写外部仿真程序自己的端口');
  }
  validate(p);
  const bindings=[],steps=[],held=n=>nativeTag(p,{area:'holding',address:p.holding+n});
  function add(section,label,value){bindings.push({section,label,value:String(value)});}
  if(native&&p.guide.plcFile)add('工程','PLC 工程文件',p.guide.plcFile);
  if(screen&&p.guide.hmiFile)add('工程','触摸屏工程文件',p.guide.hmiFile);
  if(gateway&&p.guide.gatewayFile)add('工程','网关程序文件',p.guide.gatewayFile);
  if(native){
    add('PLC','PLC 驱动',driverNames[p.native.driver]);add('PLC','仿真端地址',p.host);add('PLC','仿真端口',p.port);
    if(p.native.driver==='modbus')add('PLC','站号',p.unit);
    if(p.native.driver==='s7'){
      add('PLC','机架 / 槽号',p.native.rack+' / '+p.native.slot);if(p.native.localTSAP)add('PLC','本地 / 远端 TSAP',p.native.localTSAP+' / '+p.native.remoteTSAP);
    }
    add('PLC','接口版本 · 期望 1',held(0));add('PLC','启动代次 · 非零',held(12));add('PLC','阶段 · 1～4',held(8));
    steps.push({title:kits[d.kit].name,items:kits[d.kit].steps});
  }
  if(screen){
    if(!native){
      add('触摸屏','PLC 客户端驱动','Modbus TCP');add('触摸屏','服务器 IP','127.0.0.1');add('触摸屏','服务器端口',ports.modbus);add('触摸屏','站号',p.unit);
      add('触摸屏','验屏点 · 保持寄存器零基',p.holding+80);add('触摸屏','验屏点 · 一基偏移号',p.holding+81);
    }else{add('触摸屏','对读变量 · PLC 启动代次',held(12));add('触摸屏','PLC 端地址',p.host+':'+p.port);}
    const items=native?['在 '+screens[d.hmi].name+' 的工程副本中，按 PLC 运行端开放的协议添加设备并启动可通信的 PC 模拟。','新建只读的无符号字显示，绑定“PLC 启动代次”，在下一步输入屏上读数。']:screens[d.hmi].steps;
    steps.push({title:screens[d.hmi].name,items});
  }
  if(gateway&&!native){
    add('网关','PLC 客户端驱动','Modbus TCP');add('网关','PLC 地址','127.0.0.1');add('网关','PLC 端口',ports.modbus);add('网关','PLC 站号',p.unit);add('网关','版本寄存器 · 零基',p.holding);
  }
  if(gateway)steps.push({title:'网关程序',items:['启动网关的 PC 运行版或项目里的网关脚本。PLC 侧按点表读数，平台侧连接下面的本机 MQTT 服务。','使用本项目设备编号订阅控制主题，收到查询时保留命令编号并发回对应回执。只有硬件专用固件时，可先用内置网关测试报文。']});
  if(external){
    add('MQTT','Broker IP','127.0.0.1');add('MQTT','Broker 端口',ports.mqtt);add('MQTT','设备 Client ID',p.device);
    add('MQTT','协议 / 登录','MQTT 3.1.1 · 匿名');add('MQTT','主题前缀',p.prefix);
  }
  const topics=commandTopics(p);
  if(external)for(const entry of topics.slice(0,4)){const label=topics.length===1?'':entry.name+' · ';add('MQTT',label+'下行订阅主题',entry.topic);if(entry.reply)add('MQTT',label+'上行回执主题',entry.reply);}
  if(!steps.length)steps.push({title:'内置软件示例',items:['本机已提供 PLC 模型、模拟屏和 MQTT 平台。应用后点“检查连接”，助手会发送只读查询并核对设备回执。']});
  let sample=null;
  if(external&&p.commands.length){
    const candidate=p.commands.find(b=>{try{return b.format==='json'&&JSON.parse(b.payload)?.action==='query';}catch{return false;}})||p.commands[0];
    sample={name:candidate.name,topic:baseTopic(candidate.topic,p),payload:candidate.payload,reply:baseTopic(candidate.replyTopic,p),requestKey:candidate.requestKey,replyKey:candidate.replyKey,template:true};
    try{const x=expand(candidate,p,null,{seq:'CHECK_EXAMPLE',task:'TASK_EXAMPLE',activeTask:'TASK_EXAMPLE'});
      Object.assign(sample,{topic:x.topic,payload:x.raw,reply:x.replyTopic,template:false});}catch{/* 保留需要额外参数的项目模板。 */}
  }
  return {profile:p,native,screen,external,route:d.route,topics,bindings,steps,sample,scope:{plc:native?'已有 PLC 程序':'内置 PLC 模型',screen:screen?'已有屏工程':'模拟屏',mqtt:external?(gateway?'网关程序':'屏内 MQTT'):(owner==='gateway'?'内置网关':'内置屏端'),platform:'本机 MQTT 平台'}};
}
function baseTopic(value,p){return value.replaceAll('{{prefix}}',p.prefix).replaceAll('{{device}}',p.device);}
function commandTopics(p){
  const topics=[];const seen=new Set();
  for(const b of p.commands){
    const topic=baseTopic(b.topic,p),reply=baseTopic(b.replyTopic,p),key=topic+'\0'+reply;
    if(!seen.has(key)){topics.push({id:b.id,name:b.name,topic,reply,concrete:!topic.includes('{{')});seen.add(key);}
  }
  return topics;
}
function filterMatches(filter,topic){
  if(typeof filter!=='string'||!topic)return false;
  if(topic.startsWith('$')&&['#','+'].includes(filter.split('/')[0]))return false;
  const f=filter.split('/'),t=topic.split('/');
  for(let i=0;i<f.length;i++){if(f[i]==='#')return i===f.length-1;if(i>=t.length||f[i]!=='+'&&f[i]!==t[i])return false;}return f.length===t.length;
}
function diagnosis(err,p){
  const msg=err?.message||String(err),driver=nativeConfig(p).driver;
  if(/ECONNREFUSED|超时|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg))return '启动厂家 PC 仿真或本机桥，核对它实际监听的 IP 和 TCP 端口，再检查一次。';
  if(/异常码 11/.test(msg))return '连接已到达服务端，请核对工程的 Modbus 站号与这里是否一致。';
  if(/异常码 2|签名|点表|范围/.test(msg))return '核对导出点表的位区、字区和零基起点。先读 Version=1、Boot 非零、Phase=1～4，再映射连续的状态区。';
  if(driver==='s7')return '核对该模拟实例允许 S7 读访问、DB 号和起始字节、DB 的绝对地址以及机架、槽号或 TSAP。';
  if(driver==='mc3e')return '确认运行端开放 TCP 二进制 3E 服务，选择 Q/L 兼容设备码并核对 M 位、D 字基址。';
  return '确认端口上运行 Modbus TCP 服务端并支持读取线圈与保持寄存器，再核对站号及点表。';
}
const row=(key,title,status,detail,next='')=>({key,title,status,detail,next});
function tcp(host,port){
  return new Promise((ok,no)=>{const socket=net.connect({host,port});const finish=e=>{socket.destroy();e?no(e):ok();};socket.setTimeout(900,()=>finish(Error('TCP 连接超时')));socket.once('error',no);socket.once('connect',()=>finish());});
}
async function probe(p,ports){
  check(p.source==='native','只有外部 PLC 方案需要试读');
  const w=connectWire(p,ports.modbus),items=[];
  try{
    await tcp(w.host,w.port);items.push(row('tcp','TCP 端口','pass',w.host+':'+w.port+' 已接受连接'));
  }catch(e){return [row('tcp','TCP 端口','fail',e.code||e.message,diagnosis(e,p)),row('registers','PLC 点表','wait','等待端口接通')];}
  try{const s=await w.state();items.push(row('registers','PLC 点表','pass','接口版本 1 · 启动代次 '+s.boot+' · 阶段 '+s.running+' · 进度 '+s.progress+'%'));}
  catch(e){items.push(row('registers','PLC 点表','fail',e.message,diagnosis(e,p)));}
  finally{if(w.close)await w.close();}
  return items;
}
async function readKnown(p,ports,address){
  check(p.source==='native','请选择外部 PLC 运行端');
  check(typeof address==='string'&&address.length<=64,'请输入要试读的变量地址');
  const tag=address.trim().toUpperCase().replace(/\s+/g,''),target=structuredClone(p),n=nativeConfig(p);
  let fc,at,match;
  if(n.driver==='s7'){
    match=/^DB(\d+)\.DB(W|X)(\d+)(?:\.([0-7]))?$/.exec(tag);
    if(!match&&p.plc==='s7200'){
      const v=/^VW(\d+)$/.exec(tag),bit=/^V(\d+)\.([0-7])$/.exec(tag);
      if(v)match=[tag,'1','W',v[1],undefined];if(bit)match=[tag,'1','X',bit[1],bit[2]];
    }
    check(match&&Number(match[1])>=1&&Number(match[1])<=65535,'请填写 DB101.DBW0 或 DB100.DBX1.0 形式的地址');
    fc=match[2]==='W'?3:1;
    check((fc===3)===(match[4]===undefined)&&Number(match[3])<=(fc===3?65534:65535),'S7 字节或位地址超出范围');
    target.native={...n,...(fc===3?{wordDB:Number(match[1]),wordByte:Number(match[3])}:{bitDB:Number(match[1]),bitByte:Number(match[3])})};at=fc===3?0:Number(match[4]);
  }else{
    match=(n.driver==='mc3e'?/^(M|D)(\d+)$/:/^(C|HR)(\d+)$/).exec(tag);
    check(match,n.driver==='mc3e'?'请填写 M8 或 D100 形式的地址':'请填写 HR 0（保持寄存器）或 C 8（线圈），使用零基地址');
    at=Number(match[2]);check(at<=65535,'本台该地址范围为 0～65535');fc=['M','C'].includes(match[1])?1:3;
  }
  const wire=connectWire(target,ports.modbus);
  try{const [v]=await wire.read(fc,at,1);return row('single','程序变量试读','pass',tag+' = '+String(v)+'（'+(fc===1?'开关量':'16 位无符号数')+'）','已验证该变量可读。需要测试按钮或任务时，再检查完整联调点表。');}
  catch(e){return row('single','程序变量试读','fail',e.message,diagnosis(e,p));}
  finally{if(wire.close)await wire.close();}
}
module.exports={routes,kits,screens,driverNames,defaultPorts,infer,recognise,plan,commandTopics,filterMatches,diagnosis,row,probe,readKnown};
