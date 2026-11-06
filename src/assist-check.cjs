'use strict';
const {randomInt,randomUUID}=require('node:crypto');
const {commandTopics,filterMatches,diagnosis,infer,row}=require('./assist.cjs');

function expectScreen(p){const g=infer(p);return g.route==='hmi'||(g.route==='gateway'&&g.withScreen);}
async function startScreen(s){
  if(!expectScreen(s.p))throw Error('先在接入助手应用包含触摸屏工程的接法');
  if(!s.network)throw Error('请先接通 PLC 通道');
  const id=randomUUID(),expires=Date.now()+300000;
  let value,kind;
  if(s.bank){value=randomInt(1000,10000);kind='model';}
  else{value=(await s.wire.state()).boot;kind='native';}
  const check={id,expires,value,kind,read:false,attempts:0};
  s.screenPending=check;s.screenVerified=null;if(s.bank)s.bank.screenCheck=check;
  return {id,expires,kind};
}
async function confirmScreen(s,d){
  const v=s.screenPending;
  if(!v||d.id!==v.id||Date.now()>=v.expires)throw Error('核对已到期，请重新开始验屏');
  if(!s.network)throw Error('请先接通 PLC 通道');
  if(v.kind==='model'&&!v.read)throw Error('尚未收到验屏寄存器的读取。请核对屏的站号、地址和在线模拟方式。');
  if(++v.attempts>8){s.screenPending=null;if(s.bank)s.bank.screenCheck=null;throw Error('请重新开始验屏并读取新数值');}
  if(!/^[0-9]{1,5}$/.test(String(d.value))||Number(d.value)!==v.value)throw Error('读数不一致。请看当前运行画面的数值，核对地址零基/一基和数据类型。');
  if(v.kind==='native'&&(await s.wire.state()).boot!==v.value)throw Error('PLC 启动代次已经改变，请重新开始验屏');
  s.screenVerified={kind:v.kind,time:Date.now(),boot:v.kind==='native'?v.value:null};s.screenPending=null;if(s.bank)s.bank.screenCheck=null;
  return {message:v.kind==='model'?'已核对屏上读数和实际寄存器读取':'操作员核对的屏上数值与 PLC 当前启动代次一致'};
}
async function checkSession(s,choice,runQuery){
  await s.refresh();
  const p=s.p,l=s.links(),items=[],topics=commandTopics(p),selected=topics.find(t=>t.id===choice)||topics[0];
  items.push(l.plc?row('plc','PLC 取数','pass',(s.bank?'内置模型':'所选 PC 运行端')+' · 接口版本 1 · 启动代次 '+s.lastState.boot+' · 阶段 '+s.lastState.running):row('plc','PLC 取数','fail',l.plcError,l.plcAllowed?diagnosis(l.plcError,p):'在“项目与接入 → 通断测试”接通 PLC 通道。'));
  if(expectScreen(p)){
    const v=s.screenVerified,pending=s.screenPending;
    const verified=v&&(v.kind==='model'||l.plc&&s.lastState.boot===v.boot);
    items.push(verified?row('screen','触摸屏工程取数','pass',v.kind==='model'?'外部客户端读取了本次验屏点，输入的屏上数值吻合。':'人工对照完成，屏上读数与外部 PLC 的启动代次一致。'):
      row('screen','触摸屏工程取数','wait',pending?.read&&pending.expires>Date.now()?'已收到验屏点读取，等待核对屏上显示。':'等待从厂商运行画面核对读数。','点击“核对屏上读数”，打开仿真画面的只读数值显示。'));
  }
  items.push(row('broker','本地 MQTT 平台',l.broker&&l.platform?'pass':'fail',l.broker&&l.platform?'Broker 正在监听，平台客户端已连接。':'平台客户端尚未就绪。',''));
  const peers=Object.keys(s.broker.clients).filter(id=>id!==s.monitorId&&id!==p.device).slice(0,5);
  const who=p.receiver==='builtin'?'内置'+(p.owner==='hmi'?'屏端':'网关'):(p.owner==='hmi'?'触摸屏程序':'网关程序');
  items.push(l.device?row('device',who+'连接','pass','收到设备 Client ID '+p.device):
    row('device',who+'连接','wait',peers.length?'等待 '+p.device+'，另有客户端 '+peers.join('、'):'等待 Client ID '+p.device,
      !l.mqttAllowed?'在通断测试中恢复设备 MQTT 连接。':p.receiver==='builtin'&&!l.screenOn&&p.owner==='hmi'?'在通断测试中恢复模拟屏供电。':'启动设备的 PC 运行端，核对 MQTT 3.1.1、设备编号、127.0.0.1 和端口 '+s.base.ports.mqtt+'。'));
  const matched=!!selected?.concrete&&l.device&&l.subscriptions.some(f=>filterMatches(f,selected.topic));
  items.push(matched?row('topic','命令主题订阅','pass',selected.topic+' 已被该设备的订阅覆盖。'):
    row('topic','命令主题订阅','wait',selected?.topic||'当前项目没有物联网按钮',
      !selected?'在“物联网按钮”定义发布主题。':!selected.concrete?'此按钮的主题依赖发送参数，请用实际报文核对或选择固定主题的按钮。':l.device&&l.subscriptions.length?'已订阅 '+l.subscriptions.join('、')+'。核对前后斜杠、字母大小写和设备编号。':'连接设备后，在设备端订阅此命令主题。'));
  if(selected?.reply){
    const signature=selected.topic+'\n'+selected.reply;
    if(runQuery&&p.receiver==='builtin'&&p.source==='model'&&matched&&l.plc&&selected.topic===p.prefix+'command'&&selected.reply===p.prefix+'reply'){
      // 固定的只读查询。用户自定义按钮可以叫“查询”却实际启动任务，因此这里不执行按钮模板。
      const seq='CHECK'+randomUUID().slice(0,18);
      const raw=JSON.stringify({deviceId:p.device,seq,timestamp:Date.now(),action:'query',params:{}});
      await s.send({topic:selected.topic,raw,qos:1,replyTopic:selected.reply,requestKey:'seq',replyKey:'seq',timeout:2});
    }
    const answer=s.receipts.get(signature);
    if(l.device&&matched&&answer)items.push(row('reply','匹配的业务回执','pass','本次连接中 '+p.device+' 回报编号 '+answer.seq+'。'+(answer.success===false?'设备拒绝了该业务，收发链路已核对。':'已核对回执主题和关联字段。')));
    else items.push(row('reply','匹配的业务回执','wait','尚未观察到所选主题上由该设备发出的匹配回执。',p.receiver==='external'?'在物联网按钮发送工程定义的只读查询，再重新检查；同时核对回执主题和双方的关联字段。':'检查本机示例连接，或用项目定义的只读命令测试。'));
  }else items.push(row('reply','业务回执','skip','此按钮未配置回执主题，只能验证传输和订阅。'));
  return {items,checked:Date.now(),complete:items.every(r=>r.status==='pass'||r.status==='skip'),screen:expectScreen(p),topics,selected:selected?.id||''};
}
module.exports={checkSession,startScreen,confirmScreen};
