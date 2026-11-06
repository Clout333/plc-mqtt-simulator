'use strict';
// 配合 verify_s7.py 使用独立 Snap7 TCP 对端，端口由启动脚本分配。
const assert=require('node:assert/strict'),{readKnown}=require('../src/assist.cjs');
const {initial}=require('../src/profiles.cjs'),{connectWire,defaults}=require('../src/native.cjs');
async function main(){
 const p={...initial(),source:'native',port:Number(process.argv[2]),native:{...defaults,driver:'s7'}},wire=connectWire(p,0);
 try{
   const s=await wire.state();assert.equal(s.boot,11);assert.equal(s.running,1);
   const known=await readKnown(p,{modbus:0},'DB101.DBW24');assert.equal(known.status,'pass');assert.match(known.detail,/= 11/);
   await wire.physical('estop',true);assert.deepEqual(await wire.read(1,11,1),[true]);
   await wire.physical('estop',false);assert.deepEqual(await wire.read(1,11,1),[false]);
   assert.equal(await wire.request(1,'S7_OVER_TCP',18),1);
   assert.equal((await wire.state()).task_seq,'S7_OVER_TCP');
   assert.deepEqual(await wire.read(3,4,1),[18]);
   console.log('S7 TCP / Snap7 通过：读 DB、置位、释放、参数回读、提交、应答号及任务号');
 }finally{await wire.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
