'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {Journal,browser,reason,appVersion}=require('../src/diagnostics.cjs');
const fmt=require('../web/report-format.js');
const {fixture,external,end,ports}=require('./bench-fixture.cjs');
function temp(t){
  const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'bench-diag-'));
  t.after(()=>{if(path.dirname(fs.realpathSync(dir))!==base||!path.basename(dir).startsWith('bench-diag-'))throw Error('测试路径异常');fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
test('日志仅持久化白名单，可在多次启动间追踪同一安装',t=>{
 const dir=temp(t),j=new Journal(dir),p={plc:'haiwell',hmi:'weintek',source:'native',owner:'gateway',receiver:'external',device:'CUSTOM_SECRET',host:'10.128.164.211',guide:{kit:'haiwell',plcFile:'C:/private-user/file.gpc'}};
 j.record(p,'plc.link','fail',reason(Error('ECONNREFUSED 10.128.164.211')),{url:'CUSTOM_SECRET',softwareVersion:'123-PASSWORD',plcCode:11},'link');
 j.record(p,'plc.link','fail','refused',{plcCode:11},'link');
 j.record(p,'plc.link','pass','none',{},'link');
 const k=new Journal(dir);k.record(null,'browser.open','info','none',browser('Mozilla/5.0 foo PRIVATE_USER Chrome/126.0.1234.5 Edg/127.0.0'));
 const r=k.report(),raw=fs.readdirSync(j.dir).filter(n=>n.endsWith('.jsonl')).map(n=>fs.readFileSync(path.join(j.dir,n),'utf8')).join('');
 assert.equal(r.installation,j.installation);assert.equal(r.runs.length,2);assert.equal(r.events.length,3);assert.equal(r.events.find(e=>e.kind==='browser.open').browserMajor,127);
 assert.doesNotMatch(JSON.stringify(r)+raw,/CUSTOM_SECRET|private-user|10\.128\.164\.211|123-PASSWORD|PRIVATE_USER/);assert.equal(r.events.find(e=>e.cause==='refused').hmi,'weintek');
});
test('轮换、过期、截断和半行损坏不影响其余事件及控制结果',t=>{
 const j=new Journal(temp(t),{files:3,bytes:500,exported:4});for(let i=0;i<24;i++)j.record(null,'service.test','pass');
 assert.ok(j.files().length<=3);assert.equal(j.report().events.length,4);
 fs.appendFileSync(j.file,'{"broken"');const k=new Journal(path.dirname(j.dir));assert.ok(k.report().skipped>=1);assert.ok(k.report().events.length);
 const stale=j.files().at(-1).file;fs.utimesSync(stale,new Date(0),new Date(0));k.report();assert.equal(fs.existsSync(stale),false);
 const blocked=path.join(temp(t),'blocked');fs.writeFileSync(blocked,'file');const fallback=new Journal(blocked);
 assert.doesNotThrow(()=>fallback.record(null,'service.start','fail','storage'));assert.equal(fallback.report().persisted,false);assert.equal(fallback.report().events.length,1);
});
test('多用户报告按安装、运行和事件去重，兼容重复导出且拒绝错误格式',t=>{
 const a=new Journal(temp(t)),b=new Journal(temp(t));
 for(const j of [a,b])j.record({plc:'mitsubishi',native:{driver:'mc3e'},source:'native',owner:'hmi',receiver:'external'},'check.single','fail','refused');
 const ra=a.report(),rb=b.report(),s=fmt.summarize([ra,ra,rb]);
 assert.equal(s.installations,2);assert.equal(s.events,2);assert.equal(s.duplicates,1);assert.equal(s.issues[0].installs,2);assert.equal(s.groups[0].driver,'mc3e');
 assert.throws(()=>fmt.summarize([{...ra,format:'garbage'}]));assert.throws(()=>fmt.summarize([{...ra,events:[{...ra.events[0],run:randomUUID()}]}]));
});
test('真实网页接口记录按钮、转换、PLC 故障恢复和 MQTT 回执，不导出项目报文',async t=>{
 const f=await fixture(t),get=()=>fetch(f.url+'/api/diagnostics').then(r=>r.json());
 const health=await fetch(f.url+'/health').then(r=>r.json());assert.equal(health.version,appVersion);
 await f.physical('estop','press');await f.physical('estop','release');await f.physical('reset');
 await f.data('/api/link',{key:'plc',value:false});await f.data('/api/probe');await f.data('/api/link',{key:'plc',value:true});await f.data('/api/probe');
 await f.data('/api/assist/check',{query:true});const r=await get();
 for(const k of ['input.estop','input.release','input.reset','plc.link','mqtt.link','mqtt.message','check.reply'])assert.ok(r.events.some(e=>e.kind===k),k);
 assert.equal(r.events.find(e=>e.kind==='mqtt.message').level,'pass');assert.ok(r.events.some(e=>e.kind==='plc.link'&&e.cause==='operator'));
 assert.doesNotMatch(JSON.stringify(r),/LAB001|\/sim\/|127\.0\.0\.1|task_seq|CHECK_EXAMPLE/);
 const bad=await fetch(f.url+'/api/diagnostics',{headers:{origin:'https://invalid.example'}});assert.equal(bad.status,403);
});
test('诊断不会把其他客户端的同号应答算成预期设备应答',async t=>{
 const f=await fixture(t);await f.save({receiver:'external'});
 const p=f.app.state().project,wrong=await external(f.c,'WRONG_PRIVATE',[p.prefix+'command'],(topic,buf,client)=>{const v=JSON.parse(buf);client.publish(p.prefix+'reply',JSON.stringify({seq:v.seq,success:true}));});
 t.after(()=>end(wrong));const result=await f.button('query');assert.equal(result.response.status,'received');
 await f.data('/api/assist/check',{query:false});const r=await fetch(f.url+'/api/diagnostics').then(v=>v.json());
 assert.equal(r.events.find(e=>e.kind==='mqtt.message').cause,'source');assert.ok(r.events.some(e=>e.kind==='check.device'&&e.cause==='device'));assert.doesNotMatch(JSON.stringify(r),/WRONG_PRIVATE/);
});
test('试读失败用试验中的品牌、驱动和错误类别记账，当前项目不被改写',async t=>{
 const f=await fixture(t),unused=await ports();
 const draft={route:'plc',kit:'mitsubishi',hmi:'generic',host:'127.0.0.1',port:unused.modbus};
 await f.data('/api/assist/probe',{draft});assert.equal(f.app.state().project.source,'model');
 const r=await fetch(f.url+'/api/diagnostics').then(v=>v.json());const e=r.events.find(x=>x.kind==='check.tcp');
 assert.equal(e.plc,'mitsubishi');assert.equal(e.driver,'mc3e');assert.equal(e.cause,'refused');assert.equal(e.level,'fail');
});
test('厂家软件版本只接受版本数字，浏览器异常仅保存类别',async t=>{
 const f=await fixture(t);await f.data('/api/diagnostics/browser',{kind:'script',component:'assist',stack:'TOP_SECRET',payload:'SECRET'});
 const r=await fetch(f.url+'/api/diagnostics').then(v=>v.json());assert.ok(r.events.some(e=>e.kind==='browser.error'&&e.component==='assist'));assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 assert.deepEqual(fmt.fields({software:'haiwell',softwareVersion:'3.50.1.19',role:'hmi',raw:'CUSTOM'}),{software:'haiwell',role:'hmi',softwareVersion:'3.50.1.19'});
});
