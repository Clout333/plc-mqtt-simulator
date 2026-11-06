'use strict';
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const plcBrands = {
  generic: ['通用 Modbus TCP', 'PLC 仿真端开放 Modbus TCP 服务端，按点表实现联调接口。'],
  s7200: ['西门子 S7-200', '经典型按 CPU、通信模块和 PPI 驱动选用本机协议桥，把 V/M 区映射到本台点表。SMART 单独核对型号、固件及 Modbus TCP 库。'],
  tia: ['西门子博途', '在 TIA 工程的测试副本绑定变量。支持外部 TCP 的 PLCSIM Advanced 环境可用虚拟以太网和 MB_SERVER；也可使用本机 S7 协议桥。'],
  haiwell: ['海为', '在 PLC 仿真工程或本机协议桥中映射内部 M/V 区，触摸屏选用 Modbus TCP 客户端驱动。'],
  mitsubishi: ['三菱', '按 FX/Q/iQ 系列确认通信能力。可用的 Modbus TCP 服务端直接接入，仅有 MC/SLMP 的工程经本机协议桥映射 M/D 区。'],
  inovance: ['汇川', '用所选 CPU 和工程软件支持的 Modbus TCP 服务端，或本机协议桥，将内部位、字映射到点表。']
};
const hmiBrands = {
  generic: ['通用触摸屏', '运行有外部通信能力的 PC 仿真，将设备驱动设为 Modbus TCP 客户端。'],
  haiwell: ['海为', '在 Cloud SCADA Designer 的仿真工程副本设置 Modbus TCP 设备，用可通信的在线模拟连接。'],
  mcgs: ['昆仑通态', '在 MCGS 工程添加与所用版本匹配的 Modbus TCP 客户端设备，映射通道后启动 PC 运行环境。'],
  weintek: ['威纶通', '在 EasyBuilder Pro 添加 MODBUS TCP/IP 设备，核对零基或一基驱动，再启动可通信的在线模拟。']
};
const keys = ['start','stop','reset','estop'];
const labels = {start:'启动', stop:'停止',reset:'复位',estop:'急停'};
const check = (ok,msg) => { if (!ok) throw Error(msg); };
function num(n,min,max,label){check(Number.isInteger(n)&&n>=min&&n<=max,label+'范围为 '+min+'～'+max);return n;}
function str(x,max,label){check(typeof x==='string'&&x.trim().length&&x.length<=max,label+'为空或过长');return x;}
function id(x){check(typeof x==='string'&&/^[a-zA-Z0-9_-]{1,48}$/.test(x),'配置 ID 格式有误');return x;}
function localHost(host){
  const addresses=Object.values(os.networkInterfaces()).flat().filter(Boolean).map(n=>n.address);
  return host==='localhost'||/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)&&require('node:net').isIP(host)===4||addresses.includes(host)&&require('node:net').isIP(host)===4;
}
const builtins = ['start','stop','query'].map((action,i)=>{
  const body={deviceId:'{{device}}',seq:'{{seq}}',timestamp:'{{timestamp}}',action,params:{}};
  if(action==='start'){body.task_seq='{{task}}';body.params.recipe={recipe_id:'TEST',recipe_name:'联调任务',duration_s:'{{seconds}}'};}
  if(action==='stop')body.task_seq='{{activeTask}}';
  return {id:action,name:['远程启动','远程停止','查询任务记录'][i],topic:'{{prefix}}command',format:'json',payload:JSON.stringify(body,null,2),qos:1,replyTopic:'{{prefix}}reply',requestKey:'seq',replyKey:'seq',timeout:3};
});
function initial(water=false){
  return {id:water?'field':'general',name:water?'大田 · 按钮示例':'通用四键台',plc:water?'haiwell':'generic',hmi:water?'haiwell':'generic',owner:'hmi',receiver:'builtin',source:'model',device:water?'FIELD_SIM':'LAB001',prefix:water?'/sim/FIELD_SIM/':'/sim/LAB001/',startMode:water?'enable':'direct',buttons:{start:true,stop:!water,reset:true,estop:true},seconds:20,unit:1,coil:0,holding:0,physical:{start:8,stop:9,reset:10,estop:11},host:'127.0.0.1',port:15021,commands:structuredClone(builtins)};
}
function topic(s,allowEmpty=false){
  if(s===''&&allowEmpty)return;
  str(s,256,'主题');check(!/[#+\u0000\r\n]/.test(s)&&!s.startsWith('$SYS/'),'主题需为可发布的具体主题');
}
function command(c){
  id(c.id);str(c.name,36,'按钮名称');topic(c.topic);topic(c.replyTopic,true);
  check(['json','text'].includes(c.format),'报文格式错误');check(typeof c.payload==='string'&&Buffer.byteLength(c.payload)<=16000,'报文超过 16000 字节');
  if(c.format==='json'){try{JSON.parse(c.payload);}catch{throw Error('JSON 模板格式不正确，请给占位符加双引号');}}
  num(c.qos,0,2,'QoS');num(c.timeout,1,30,'回执等待秒数');
  for(const s of [c.requestKey,c.replyKey])check(typeof s==='string'&&s.length<=80&&(!s||/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(s)),'关联字段请使用 JSON 字段路径');
  if(c.replyTopic)check(c.requestKey&&c.replyKey&&c.format==='json','等待业务回执时须设置 JSON 收发关联字段');
  return c;
}
function validate(p){
  id(p.id);str(p.name,48,'项目名称');check(Object.hasOwn(plcBrands,p.plc)&&Object.hasOwn(hmiBrands,p.hmi),'品牌选项无效');
  for(const [k,opts] of Object.entries({owner:['hmi','gateway'],receiver:['builtin','external'],source:['model','native'],startMode:['direct','enable']}))check(opts.includes(p[k]),'项目选项无效 '+k);
  check(/^[A-Za-z0-9_-]{1,32}$/.test(p.device),'设备编号用 1～32 位字母、数字、下划线或横线');
  topic(p.prefix);check(p.prefix.endsWith('/')&&!/[{}\s]/.test(p.prefix),'主题前缀须以 / 结尾且无空白或占位符');
  num(p.seconds,1,3600,'任务秒数');num(p.unit,1,247,'站号');num(p.coil,0,65000,'线圈基址');num(p.holding,0,65000,'寄存器基址');
  if(p.native){
    const n=p.native;check(['modbus','s7','mc3e'].includes(n.driver),'可选驱动为 Modbus TCP、S7 和 MC 3E');
    for(const k of ['bitDB','wordDB'])num(n[k],1,65535,k);
    for(const k of ['bitByte','wordByte','localTSAP','remoteTSAP'])num(n[k],0,65535,k);
    num(n.rack,0,7,'机架');num(n.slot,0,31,'槽号');check(!!n.localTSAP===!!n.remoteTSAP,'本地和远端 TSAP 应同时填写或均设为 0');
    if(n.driver==='s7'){
      const lo=Math.min(p.coil,...Object.values(p.physical||{})),hi=Math.max(p.coil+6,...Object.values(p.physical||{}));
      const firstBitByte=n.bitByte+Math.floor(lo/8),lastBitByte=n.bitByte+Math.floor(hi/8);
      const firstWord=n.wordByte+2*p.holding,lastWord=firstWord+111;
      check(lastBitByte<65536&&lastWord<65536,'S7 DB 地址越界');check(n.bitDB!==n.wordDB||lastBitByte<firstWord||lastWord<firstBitByte,'S7 同一 DB 的位区与字区重叠');
    }
  }
  check(localHost(p.host),'目标地址须为回环地址或本机持有的 IPv4 地址');num(p.port,1,65535,'目标端口');
  for(const k of keys){check(typeof p.buttons?.[k]==='boolean','四个按钮都须设置启用状态');num(p.physical?.[k],0,65535,k+' 线圈地址');check(p.physical[k]<p.coil||p.physical[k]>p.coil+6,'物理按钮地址与握手/状态线圈重叠');}
  check(new Set(keys.map(k=>p.physical[k])).size===4,'按钮地址不可重复');
  check(Array.isArray(p.commands)&&p.commands.length<=48,'每个项目最多 48 个 MQTT 按钮');
  p.commands.forEach(command);check(new Set(p.commands.map(c=>c.id)).size===p.commands.length,'按钮 ID 重复');
  return p;
}
function expand(c,p,state,values={}){
  command(c);
  const variables={prefix:p.prefix,device:p.device,seq:'C'+randomUUID().slice(0,20),task:'T'+randomUUID().slice(0,20),activeTask:state?.task_seq||'',timestamp:Date.now(),seconds:p.seconds};
  for(const [k,v] of Object.entries(values)){check(/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k),'参数名无效');check(v===null||['string','boolean','number'].includes(typeof v),'参数值仅允许简单值');variables[k]=v;}
  const token=/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
  function value(key){check(Object.hasOwn(variables,key),'缺少模板参数 '+key);return variables[key];}
  const subst=s=>s.replace(token,(_,key)=>String(value(key)));
  function walk(v){
    if(typeof v==='string'){const whole=/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/.exec(v);return whole?value(whole[1]):subst(v);}
    if(Array.isArray(v))return v.map(walk);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,val])=>[k,walk(val)]));
    return v;
  }
  const to=subst(c.topic),reply=subst(c.replyTopic);topic(to);topic(reply,true);
  check(!reply||reply!==to,'指令和回执主题须分开');
  const raw=c.format==='json'?JSON.stringify(walk(JSON.parse(c.payload))):subst(c.payload);
  check(Buffer.byteLength(raw)<=16384,'展开后报文超过 16384 字节');
  return {topic:to,replyTopic:reply,raw,qos:c.qos,requestKey:c.requestKey,replyKey:c.replyKey,timeout:c.timeout};
}
function field(obj,key){for(const k of key.split('.')){if(!obj||typeof obj!=='object'||!Object.hasOwn(obj,k))return undefined;obj=obj[k];}return obj;}
module.exports={initial,validate,command,expand,field,topic,keys,labels,plcBrands,hmiBrands,localHost};
