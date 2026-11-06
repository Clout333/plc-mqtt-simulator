'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),path=require('node:path');
const {listen}=require('../src/session.cjs'),{Wire,BenchBank,wait}=require('../src/wire.cjs');
const {createModbus}=require('../src/modbus.cjs'),{Model}=require('../src/model.cjs'),{initial,expand,validate}=require('../src/profiles.cjs'),{nativeTag,defaults}=require('../src/native.cjs');
const base=require('../project.json'),{fixture,until,external,end}=require('./bench-fixture.cjs');
test('四按钮：直接启动、正常停止、急停释放后保持故障、复位再启动',async t=>{
 const f=await fixture(t);await f.physical('start');assert.ok(f.app.state().plc.busy);await f.physical('stop');assert.equal(f.app.state().plc.running,4);
 await f.data('/api/advance',{seconds:3});assert.equal(f.app.state().plc.busy,false);
 await f.physical('start');await f.physical('estop','press');assert.equal(f.app.state().plc.fault,true);assert.equal(f.app.state().plc.busy,false);
 await f.physical('reset');assert.equal(f.app.state().plc.fault,true);await f.physical('estop','release');assert.equal(f.app.state().plc.fault,true);
 await f.physical('reset');assert.equal(f.app.state().plc.fault,false);await f.physical('start');assert.equal(f.app.state().plc.busy,true);
});
test('大田示例：只给许可、屏上启动；停用按钮经网页和外部线圈都无动作',async t=>{
 const f=await fixture(t);await f.data('/api/project/select',{id:'field'});assert.equal((await f.data('/api/hmi',{action:'start'})).code,10);
 await f.physical('start');assert.equal(f.app.state().plc.busy,false);assert.equal(f.app.state().plc.enabled,true);
 await f.data('/api/hmi',{action:'start'});assert.equal((await f.physical('stop')).applied,false);
 const wire=new Wire(f.app.state().project,f.c.ports.modbus);await wire.physical('stop',true);assert.equal((await wire.state()).running,2);assert.equal((await wire.read(1,9,1))[0],false);
});
test('禁用全部物理按钮时独立 MQTT 和屏上入口可运行',async t=>{
 const f=await fixture(t);await f.save({startMode:'enable',buttons:{start:false,stop:false,reset:false,estop:false}});
 for(const k of ['start','stop','reset','estop'])assert.equal((await f.physical(k,k==='estop'?'press':'pulse')).applied,false);
 assert.equal((await f.button('start')).response.payload.success,true);
});
test('真实 MQTT 启动、停止、查询与关联回执；同任务重发不重启',async t=>{
 const f=await fixture(t);const a=await f.button('start',{seq:'CMD_A',task:'TASK_A',seconds:12});assert.equal(a.response.payload.source,'hmi');assert.equal(a.response.payload.success,true);
 assert.equal((await f.button('start',{seq:'CMD_A',task:'TASK_A',seconds:12})).response.payload.success,true);
 const denied=await f.button('start',{seq:'CMD_A',task:'OTHER'});assert.equal(denied.response.payload.success,false);
 await f.data('/api/advance',{seconds:5});assert.equal(f.app.state().plc.task_seq,'TASK_A');
 await f.button('stop');await f.data('/api/advance',{seconds:4});
 const q=await f.button('query');assert.equal(q.response.payload.records[0].task_seq,'TASK_A');assert.equal(f.app.state().results.length,1);
 assert.ok(f.app.state().frames.some(x=>x.topic.endsWith('/reply')&&x.seq==='CMD_A'));
});
test('自定义按钮增删改、带类型参数的预览、外部回执内容及关联过滤',async t=>{
 const f=await fixture(t),p=f.app.state().project;
 const b={id:'speed',name:'调节转速',topic:'lab/{{device}}/speed',qos:1,format:'json',payload:'{"cmd":{"id":"{{seq}}"},"v":"{{rpm}}"}',replyTopic:'lab/reply',requestKey:'cmd.id',replyKey:'answer.id',timeout:2};
 await f.data('/api/button/save',{button:b});b.name='调速';await f.data('/api/button/save',{button:b});
 const preview=await f.data('/api/button/preview',{id:'speed',values:{rpm:1250,seq:'Q1'}});assert.equal(JSON.parse(preview.raw).v,1250);assert.equal(preview.topic,'lab/LAB001/speed');
 const ext=await external(f.c,'custom-peer',preview.topic,(topic,bytes,cl)=>{const m=JSON.parse(bytes);cl.publish('lab/reply',JSON.stringify({answer:{id:'wrong'}}));cl.publish('lab/reply',JSON.stringify({answer:{id:m.cmd.id},v:m.v}));});
 try{const r=await f.button('speed',{rpm:1250,seq:'Q1'});assert.deepEqual(r.response.payload,{answer:{id:'Q1'},v:1250});assert.equal(r.response.deviceVerified,false);}
 finally{await end(ext);}
 await f.data('/api/project/select',{id:'field'});assert.ok(!f.app.state().project.commands.some(x=>x.id==='speed'));
 await f.data('/api/project/select',{id:p.id});assert.equal(f.app.state().project.commands.find(x=>x.id==='speed').name,'调速');
 await f.data('/api/button/delete',{id:'speed'});assert.ok(!f.app.state().project.commands.some(x=>x.id==='speed'));
});
test('纯文本自定义按钮实际到达独立订阅方，QoS 0 不冒充业务受理',async t=>{
 const f=await fixture(t);const b={id:'raw',name:'开灯',topic:'factory/light',qos:0,format:'text',payload:'ON={{value}}',replyTopic:'',requestKey:'',replyKey:'',timeout:1};
 let received;const peer=await external(f.c,'raw-peer',b.topic,(t,b)=>{received=b.toString();});
 try{await f.data('/api/button/save',{button:b});const r=await f.button('raw',{value:1});assert.equal(r.response.status,'untracked');await until(()=>received==='ON=1');}finally{await end(peer);}
});
test('外部网关模式：无设备时超时、有独立订阅方才回执',async t=>{
 const f=await fixture(t);await f.save({owner:'gateway',receiver:'external'});
 const p=f.app.state().project;await f.data('/api/button/save',{button:{...p.commands[0],timeout:1}});
 assert.equal((await f.button('start')).response.status,'timeout');assert.equal(f.app.state().plc.busy,false);
 const wire=new Wire(p,f.c.ports.modbus);const peer=await external(f.c,p.device,p.prefix+'command',async(t,b,client)=>{
   const v=JSON.parse(b);const code=await wire.request(1,v.task_seq,v.params.recipe.duration_s);client.publish(p.prefix+'reply',JSON.stringify({seq:v.seq,code,source:'external-program'}));
 });
 try{const r=await f.button('start');assert.equal(r.response.payload.source,'external-program');assert.ok((await wire.state()).busy);await assert.rejects(()=>f.data('/api/hmi',{action:'stop'}),/外部/);}finally{await end(peer);}
});
test('屏断电时触摸屏 MQTT 掉线；独立网关仍应答；屏上操作受锁',async t=>{
 const f=await fixture(t);await f.data('/api/link',{key:'screen',value:false});await until(()=>!f.app.state().links.device);
 await f.data('/api/link',{key:'screen',value:true});await until(()=>f.app.state().links.subscribed);
 await f.save({owner:'gateway'});await f.data('/api/link',{key:'screen',value:false});
 await assert.rejects(()=>f.data('/api/hmi',{action:'start'}),/断电/);assert.equal((await f.button('start')).response.payload.source,'gateway');
});
test('PLC、MQTT 断线分别显示且恢复；模型不受 MQTT 掉线影响',async t=>{
 const f=await fixture(t);await f.button('start');await f.data('/api/link',{key:'mqtt',value:false});await until(()=>!f.app.state().links.device);
 assert.ok(f.app.session.model.busy);await f.data('/api/link',{key:'mqtt',value:true});await until(()=>f.app.state().links.subscribed);
 await f.data('/api/link',{key:'plc',value:false});assert.equal(f.app.state().plc,null);await assert.rejects(()=>f.physical('start'),/断开/);
 await f.data('/api/link',{key:'plc',value:true});await until(()=>f.app.state().links.plc);
});
test('任务中禁切项目；过期页面指令被拦截；导入导出配置与点表一致',async t=>{
 const f=await fixture(t);const old=f.app.state().epoch;await f.physical('start');await assert.rejects(()=>f.data('/api/project/select',{id:'field'}),/结束当前任务/);
 await f.physical('estop','press');await f.physical('estop','release');await f.physical('reset');
 const pkg=await (await fetch(f.url+'/api/export')).json();await f.data('/api/project/import',{package:pkg,device:'COPY1',prefix:'/copy/'});
 assert.equal(f.app.state().project.device,'COPY1');await assert.rejects(()=>f.data('/api/physical',{epoch:old,key:'start',action:'pulse'}),/过期/);
 const csv=await (await fetch(f.url+'/api/points.csv')).text();assert.match(csv,/Sim_estop/);assert.match(csv,/驱动地址/);
 await f.data('/api/project/new',{name:'另一台'});assert.equal(f.app.state().project.name,'另一台');
});
test('外接独立 Modbus PLC：非默认站号、基址、物理位均用于网络读写',async t=>{
 const f=await fixture(t),p={...initial(),unit:7,coil:100,holding:400,physical:{start:208,stop:210,reset:214,estop:220}};
 const c={...base,unitId:p.unit,modbus:{coilBase:p.coil,holdingBase:p.holding},requireEnable:false};
 const m=new Model(c,path.join(f.dir,'independent-peer')),bank=new BenchBank(m,c,p),peer=createModbus(bank);await listen(peer.server,0);
 try{
   await f.save({...p,source:'native',port:peer.server.address().port});assert.equal(f.app.session.model,undefined);
   await f.physical('start');assert.ok(m.busy);await f.physical('estop','press');assert.equal(m.fault,1);
   await f.physical('estop','release');await f.physical('reset');assert.equal(m.fault,0);
   const r=await f.button('start',{task:'NATIVE_T1'});assert.equal(r.response.payload.success,true);assert.equal(m.active.task_seq,'NATIVE_T1');
 }finally{await peer.close();}
});
test('外部端点未开放或点表版本错误时，界面无伪造 PLC 数值',async t=>{
 const f=await fixture(t);const wrong=net.createServer(s=>{s.on('error',()=>{});s.on('data',b=>{const n=b.readUInt16BE(10),fc=b[7],length=fc===3?2*n:Math.ceil(n/8),out=Buffer.alloc(9+length);b.copy(out,0,0,7);out.writeUInt16BE(3+length,4);out[7]=fc;out[8]=length;s.end(out);});});await listen(wrong,0);
 try{await f.save({source:'native',port:wrong.address().port});assert.equal(f.app.state().plc,null);assert.match(f.app.state().links.plcError,/点表/);}
 finally{await new Promise(r=>wrong.close(r));}
 await f.data('/api/probe');assert.equal(f.app.state().plc,null);
});
test('只接受本机同源操作；保留控制消息被 Broker 拒绝',async t=>{
 const f=await fixture(t);const r=await fetch(f.url+'/api/physical',{method:'POST',headers:{origin:'http://bad.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
 const cl=await external(f.c,'retain-test','unused');const p=f.app.state().project,x=expand(p.commands[0],p,null);cl.publish(x.topic,x.raw,{qos:1,retain:true});await wait(180);assert.equal(f.app.session.model.busy,false);await end(cl);
});
test('地址与协议模板验证：未知参数、重叠点、远端实际 IP、S7 DB 重叠',()=>{
 const p=initial();assert.throws(()=>validate({...p,host:'198.51.100.15'}),/本机/);
 assert.throws(()=>validate({...p,physical:{...p.physical,reset:0}}),/重叠/);assert.throws(()=>expand({...p.commands[0],payload:'{"x":"{{missing}}"}'},p,null),/缺少/);
 assert.throws(()=>validate({...p,native:{...defaults,driver:'s7',wordDB:100}}),/重叠/);
 assert.equal(nativeTag({...p,source:'native',native:{...defaults,driver:'s7'}},{area:'holding',address:2}),'DB101.DBW4');
});
