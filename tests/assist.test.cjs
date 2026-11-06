'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {fixture,until,external,end}=require('./bench-fixture.cjs');
const {plan,recognise,filterMatches}=require('../src/assist.cjs'),{initial}=require('../src/profiles.cjs'),{Model}=require('../src/model.cjs'),{Wire,BenchBank,wait}=require('../src/wire.cjs');
const {createModbus}=require('../src/modbus.cjs'),{listen}=require('../src/session.cjs');
const base=require('../project.json'),ports=base.ports,form={route:'plc',kit:'haiwell',hmi:'haiwell'};
const row=(r,k)=>r.items.find(v=>v.key===k);
test('工程识别覆盖多个版本、同名相对路径、厂商 XML 与无法判断的 ST',()=>{
 const r=recognise([{name:'A.gpc',label:'R1/A.gpc'},{name:'A.gpc',label:'R2/A.gpc'},{name:'屏.hwdev'},{name:'泵.xml',vendor:'InoProShop'},{name:'Main.st'},{name:'项目.ap19'},{name:'屏.cmtp'}]);
 assert.equal(r.plc.find(v=>v.key==='haiwell').count,2);assert.deepEqual(r.candidates.slice(0,2).map(v=>v.name),['R1/A.gpc','R2/A.gpc']);assert.deepEqual(r.unclassified,['Main.st']);
 assert.ok(r.plc.some(v=>v.key==='tia'));assert.ok(r.plc.some(v=>v.key==='inovance'));assert.ok(r.hmi.some(v=>v.key==='weintek'));
});
test('品牌接法生成相应驱动，S7-200 经典与 SMART 分列；点表与测试范围使用当前配置',()=>{
 const p=initial(true);for(const [kit,driver] of [['generic','modbus'],['haiwell','modbus'],['tia','s7'],['smart','modbus'],['classic','modbus'],['mitsubishi','mc3e'],['inovance','modbus']]){
   const planInfo=plan(p,{...form,kit},ports);assert.equal(planInfo.profile.native.driver,driver);assert.equal(planInfo.scope.plc,'已有 PLC 程序');assert.deepEqual(planInfo.profile.buttons,p.buttons);
 }
 const smart=plan(p,{...form,kit:'smart',driver:'s7'},ports);assert.equal(smart.profile.native.bitDB,1);assert.equal(smart.profile.native.wordByte,256);
 const edited={...smart.profile,port:1102,native:{...smart.profile.native,slot:5}};const again=plan(edited,{...form,kit:'smart',driver:'s7'},ports);assert.equal(again.profile.port,1102);assert.equal(again.profile.native.slot,5);
});
test('共享格式须确认，网关源文件保留给工程师指定；预览报文与定制按钮一致',()=>{
 const r=recognise([{name:'显示.mcp'},{name:'程序.hcp'},{name:'gateway.lua'}]);
 assert.ok(r.candidates.every(v=>v.confirm));assert.deepEqual(r.unclassified,['gateway.lua']);
 const p=initial(),d={...form,route:'gateway',gatewayFile:'gateway.lua'};p.commands=[{...p.commands[0],topic:'speed/{{device}}',payload:'{"rpm":"{{rpm}}"}',replyTopic:'speed/reply'}];
 const q=plan(p,d,ports);assert.ok(q.sample.template);assert.equal(q.sample.payload,p.commands[0].payload);assert.equal(q.topics[0].topic,'speed/LAB001');assert.equal(q.bindings[0].value,'gateway.lua');
});
test('三种屏的接入单区别驱动编号；屏显示、网关、全链路各自拥有正确的 MQTT 写入方',()=>{
 const p={...initial(),holding:550,unit:3};
 for(const hmi of ['haiwell','mcgs','weintek']){
   const q=plan(p,{...form,route:'hmi',hmi,screenMqtt:false},ports);
   assert.equal(q.profile.receiver,'builtin');assert.equal(q.profile.owner,'gateway');assert.equal(q.bindings.find(b=>b.label.includes('一基')).value,'631');assert.ok(q.steps[0].title);
 }
 const g=plan(p,{...form,route:'gateway',withPlc:true,withScreen:true},ports);assert.equal(g.profile.receiver,'external');assert.equal(g.profile.source,'native');assert.ok(g.screen);assert.ok(g.bindings.some(b=>b.label==='设备 Client ID'));
});
test('本机工程目录读取有界，保留同名版本；没有文件、根目录和非本机地址时给出诊断',async t=>{
 const f=await fixture(t),dir=path.join(f.dir,'项目 副本');fs.mkdirSync(path.join(dir,'V2'),{recursive:true});
 fs.writeFileSync(path.join(dir,'控制.gpc'),'original');fs.writeFileSync(path.join(dir,'V2','控制.gpc'),'new');fs.writeFileSync(path.join(dir,'屏.hwdev'),'pw');fs.writeFileSync(path.join(dir,'导出.xml'),'<fileHeader companyName="Inovance" productName="InoProShop"/>');
 const r=await f.data('/api/assist/path',{path:'"'+dir+'"'});assert.equal(r.candidates.length,4);assert.equal(r.plc.find(v=>v.key==='haiwell').count,2);assert.equal(fs.readFileSync(path.join(dir,'控制.gpc'),'utf8'),'original');
 for(const v of [path.parse(dir).root,path.join(dir,'未找到.st'),'relative/path','\\\\server\\area'])await assert.rejects(()=>f.data('/api/assist/path',{path:v}));
});
test('预览和只读试连不保存参数，不写输入；端口开但点表错时列出实际版本和修复步骤',async t=>{
 const f=await fixture(t);let writes=0;
 const peer=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',b=>{if(b.length<12)return;const fc=b[7],n=b.readUInt16BE(10);if(![1,3].includes(fc))writes++;
 const sz=fc===3?2*n:Math.ceil(n/8),out=Buffer.alloc(sz+9);b.copy(out,0,0,7);out.writeUInt16BE(sz+3,4);out[7]=fc;out[8]=sz;if(fc===3)out.writeUInt16BE(73,9);socket.end(out);});});
 await listen(peer,0);const draft={...form,port:peer.address().port};const before=f.app.state().epoch;
 try{const q=await f.data('/api/assist/probe',{draft});assert.equal(q[0].status,'pass');assert.equal(q[1].status,'fail');assert.match(q[1].detail,/73/);assert.match(q[1].next,/Version/);
 const reg=await f.data('/api/assist/read',{draft,address:'HR 0'});assert.equal(reg.status,'pass');assert.match(reg.detail,/73/);
 const bit=await f.data('/api/assist/read',{draft,address:'C 8'});assert.equal(bit.status,'pass');assert.match(bit.detail,/false/);
 await assert.rejects(()=>f.data('/api/assist/read',{draft,address:'Y2 = 1'}),/HR 0/);
 assert.equal(writes,0);assert.equal(f.app.state().epoch,before);assert.equal(f.app.state().project.source,'model');}finally{await new Promise(r=>peer.close(r));}
 const closed=await f.data('/api/assist/probe',{draft});assert.equal(closed[0].status,'fail');assert.equal(closed[1].status,'wait');
 await assert.rejects(()=>f.data('/api/assist/probe',{draft:{...draft,host:'198.51.100.24'}}),/本机/);
 await assert.rejects(()=>f.data('/api/assist/probe',{draft:{...draft,port:f.c.ports.modbus}}),/内置 PLC/);
});
test('向导应用保留原项目按钮和配方模板，任务中不可换接法',async t=>{
 const f=await fixture(t);await f.data('/api/project/select',{id:'field'});const p=f.app.state().project,epoch=f.app.state().epoch;
 await f.data('/api/assist/plan',{draft:{...form,route:'hmi'}});assert.equal(f.app.state().epoch,epoch);
 await f.physical('start');await f.data('/api/hmi',{action:'start'});
 await assert.rejects(()=>f.data('/api/assist/apply',{draft:{...form,route:'hmi'}}),/结束当前任务/);
 await f.physical('estop','press');await f.physical('estop','release');await f.physical('reset');
 await f.data('/api/assist/apply',{draft:{...form,route:'hmi'}});const n=f.app.state().project;assert.deepEqual(n.buttons,p.buttons);assert.deepEqual(n.commands,p.commands);assert.equal(n.device,p.device);assert.equal(n.startMode,'enable');
});
test('快捷检查按已保存的项目读数，保持网关角色、原工程和当前任务',async t=>{
 const f=await fixture(t);await f.save({owner:'gateway'});
 await f.physical('start');const before=f.app.state();assert.ok(before.plc.busy);
 const sheet=await f.data('/api/assist/current');
 assert.equal(sheet.scope.mqtt,'内置网关');assert.equal(sheet.profile.owner,'gateway');
 const result=await f.data('/api/assist/check',{query:true});assert.equal(row(result,'reply').status,'pass');
 const after=f.app.state();assert.equal(after.epoch,before.epoch);assert.deepEqual(after.project,before.project);
 assert.ok(after.plc.busy);assert.equal(after.plc.task_seq,before.plc.task_seq);
});
test('重新检查若未收到本次应答，旧回执不会继续显示成功',async t=>{
 const f=await fixture(t);
 assert.equal(row(await f.data('/api/assist/check',{query:true}),'reply').status,'pass');
 f.app.session.device.removeAllListeners('message');
 assert.equal(row(await f.data('/api/assist/check',{query:true}),'reply').status,'wait');
 assert.equal(row(await f.data('/api/assist/check'),'reply').status,'wait');
});
test('无硬件示例确实发送只读 MQTT 查询；自定义同名按钮即使实际是启动也不执行',async t=>{
 const f=await fixture(t),p=f.app.state().project,b={...p.commands.find(x=>x.id==='start'),id:'query',name:'查询',payload:p.commands[0].payload};
 await f.data('/api/button/save',{button:b});const report=await f.data('/api/assist/check',{query:true});
 assert.equal(row(report,'reply').status,'pass');assert.equal(report.complete,true);assert.ok(!f.app.session.model.busy);
 const frame=f.app.session.frames.find(x=>x.flow==='下发');assert.equal(JSON.parse(frame.raw).action,'query');
});
test('外部屏验屏：后台轮询不能通过，错误数值不通过，必须真实读取当次挑战；旧挑战失效',async t=>{
 const f=await fixture(t);await f.data('/api/assist/apply',{draft:{...form,route:'hmi',screenMqtt:false}});
 const a=await f.data('/api/assist/screen-start');assert.ok(!('value' in a));await f.app.session.refresh();
 await assert.rejects(()=>f.data('/api/assist/screen-confirm',{id:a.id,value:'1234'}),/尚未收到/);
 const w=new Wire(f.app.state().project,f.c.ports.modbus);const [value]=await w.read(3,f.app.state().project.holding+80,1);assert.ok(value>=1000&&value<10000);
 await assert.rejects(()=>f.data('/api/assist/screen-confirm',{id:a.id,value:0}),/不一致/);
 await f.data('/api/assist/screen-confirm',{id:a.id,value});assert.equal(row(await f.data('/api/assist/check'),'screen').status,'pass');
 const b=await f.data('/api/assist/screen-start');await assert.rejects(()=>f.data('/api/assist/screen-confirm',{id:a.id,value}),/到期/);
 f.app.session.screenPending.expires=Date.now()-1;await assert.rejects(()=>f.data('/api/assist/screen-confirm',{id:b.id,value}),/到期/);
});
test('MQTT 订阅要匹配当前命令，区分 Client ID 错误、错误主题和通配符',async t=>{
 const f=await fixture(t);await f.data('/api/assist/apply',{draft:{...form,route:'gateway'}});const p=f.app.state().project;
 const other=await external(f.c,'WRONG-ID','wrong');let actual;
 try{
   const one=await f.data('/api/assist/check',{query:true});assert.equal(row(one,'device').status,'wait');assert.match(row(one,'device').detail,/WRONG-ID/);
   actual=await external(f.c,p.device,'/unrelated/#');await until(()=>f.app.state().links.subscribed);
   assert.equal(row(await f.data('/api/assist/check'),'topic').status,'wait');assert.equal(f.app.state().links.matched,false);
   await new Promise((ok,no)=>actual.subscribe('/sim/+/command',e=>e?no(e):ok()));await until(()=>f.app.state().links.matched);
   const r=await f.data('/api/assist/check',{query:true});assert.equal(row(r,'topic').status,'pass');assert.equal(row(r,'reply').status,'wait');assert.ok(!f.app.session.frames.find(x=>x.flow==='下发'));
 }finally{if(actual)await end(actual);await end(other);}
 assert.ok(filterMatches('a/#','a'));assert.ok(!filterMatches('/a/+','/a'));assert.ok(!filterMatches('#','$SYS/uptime'));
});
test('验证回执须来自本次设备连接与匹配编号，其他客户端回执、断线和旧日志均不能代替',async t=>{
 const f=await fixture(t);await f.data('/api/assist/apply',{draft:{...form,route:'gateway'}});const p=f.app.state().project;
 let counter=0,rogue=await external(f.c,'observer','unused');
 const device=await external(f.c,p.device,p.prefix+'command',(topic,body,cl)=>{const v=JSON.parse(body),sender=++counter===1?rogue:cl;sender.publish(p.prefix+'reply',JSON.stringify({seq:v.seq,success:false}));});
 try{
  const wrongSource=await f.button('query');assert.equal(wrongSource.response.status,'timeout');assert.equal(row(await f.data('/api/assist/check'),'reply').status,'wait');
  const correct=await f.button('query');assert.equal(correct.response.deviceVerified,true);await until(async()=>row(await f.data('/api/assist/check'),'reply').status==='pass');
  assert.match(row(await f.data('/api/assist/check'),'reply').detail,/拒绝/);
 }finally{await end(device);await end(rogue);}
 const newPeer=await external(f.c,p.device,p.prefix+'command');
 try{assert.equal(row(await f.data('/api/assist/check'),'reply').status,'wait');}finally{await end(newPeer);}
});
test('独立 PLC 的屏上人工对读与内置挑战分开；试连使用非默认站号、端口、地址',async t=>{
 const f=await fixture(t),p={...initial(),unit:5,holding:300},m=new Model({...base,unitId:5,modbus:{coilBase:0,holdingBase:300}},path.join(f.dir,'independent')),bank=new BenchBank(m,{...base,unitId:5,modbus:{coilBase:0,holdingBase:300}},p),peer=createModbus(bank);
 await listen(peer.server,0);try{
   const d={...form,route:'hmi',withPlc:true,screenMqtt:false,port:peer.server.address().port,holding:300,unit:5};
   const draft=await f.data('/api/assist/probe',{draft:d});assert.equal(draft[1].status,'pass');
   await f.data('/api/assist/apply',{draft:d});const v=await f.data('/api/assist/screen-start');assert.equal(v.kind,'native');await f.data('/api/assist/screen-confirm',{id:v.id,value:m.saved.boot});
   assert.match(row(await f.data('/api/assist/check'),'screen').detail,/人工/);assert.equal(bank.valid,false);assert.ok(!m.busy);
 }finally{await peer.close();}
});
test('预览点表可在应用前下载，原连接与工程点表未改动',async t=>{
 const f=await fixture(t),before=f.app.state().epoch;const draft={...form,kit:'mitsubishi',holding:222,coil:100,physical:{start:118,stop:119,reset:120,estop:121}};
 const sheet=await f.data('/api/assist/points',{draft});assert.match(sheet.csv,/"D222"/);assert.match(sheet.csv,/"M121"/);assert.equal(f.app.state().epoch,before);assert.equal(f.app.state().project.holding,0);
});
