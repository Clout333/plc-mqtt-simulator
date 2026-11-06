'use strict';
const fs=require('node:fs'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const mqtt=require('mqtt'),{start}=require('../src/server.cjs'),{listen}=require('../src/session.cjs'),{wait}=require('../src/wire.cjs');
const root=path.resolve(__dirname,'..'),base=require('../project.json');
async function ports(){
  const ss=[];for(let i=0;i<3;i++){const s=net.createServer();await listen(s,0);ss.push(s);}
  const arr=ss.map(s=>s.address().port);for(const s of ss)await new Promise(r=>s.close(r));return {http:arr[0],mqtt:arr[1],modbus:arr[2]};
}
async function until(fn){for(let i=0;i<50;i++){if(await fn())return;await wait(80);}throw Error('等待条件超时');}
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bench-integration-')),c={...structuredClone(base),ports:await ports()};
  const app=await start(root,c,{dataDir:dir}),url='http://127.0.0.1:'+c.ports.http;
  const data=async(endpoint,v={})=>{const r=await fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({epoch:app.state().epoch,...v})});let obj=await r.json();if(!r.ok)throw Error(obj.error);return obj;};
  t.after(async()=>{await app.stop();if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('bench-integration-'))throw Error('测试目录越界');fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,c,app,data,url,save:changes=>data('/api/project/save',{project:{...app.state().project,...changes}}),physical:(key,action='pulse')=>data('/api/physical',{key,action}),button:(id,values)=>data('/api/button/send',{id,values})};
}
async function external(c,deviceId,topics,onMessage){
  const cl=mqtt.connect('mqtt://127.0.0.1:'+c.ports.mqtt,{clientId:deviceId,reconnectPeriod:0,protocolVersion:4});cl.on('error',()=>{});
  cl.on('message',(topic,b)=>onMessage?.(topic,b,cl));
  await new Promise((ok,no)=>{cl.once('error',no);cl.once('connect',()=>cl.subscribe(topics,{qos:1},(e)=>e?no(e):ok()));});return cl;
}
const end=cl=>new Promise(r=>cl.end(true,{},r));
module.exports={ports,until,fixture,external,end};
