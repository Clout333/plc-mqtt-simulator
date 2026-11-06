'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {initial}=require('../src/profiles.cjs'),{defaults,connectWire,S7Wire}=require('../src/native.cjs'),{listen}=require('../src/session.cjs');
test('三菱 MC 3E 对测：M 位脉冲、D 字区、完整请求与匹配应答',async t=>{
 const bits=Array(100).fill(false),regs=Array(100).fill(0);regs[0]=1;regs[8]=1;regs[12]=7;
 const server=net.createServer(s=>{let buf=Buffer.alloc(0);s.on('error',()=>{});s.on('data',chunk=>{
  buf=Buffer.concat([buf,chunk]);if(buf.length<9||buf.length<9+buf.readUInt16LE(7))return;
  assert.equal(buf.readUInt16LE(0),0x50);const op=buf.readUInt16LE(11),bit=buf.readUInt16LE(13)===1,a=buf.readUIntLE(15,3),n=buf.readUInt16LE(19);
  assert.equal(buf[18],bit?0x90:0xa8);let payload=Buffer.alloc(0);
  if(op===0x0401){payload=Buffer.alloc(bit?Math.ceil(n/2):n*2);for(let i=0;i<n;i++){if(bit){if(bits[a+i])payload[i>>1]|=i%2?1:16;}else payload.writeUInt16LE(regs[a+i],i*2);}}
  else{assert.equal(op,0x1401);for(let i=0;i<n;i++){if(bit)bits[a+i]=!!(buf[21+(i>>1)]&(i%2?1:16));else regs[a+i]=buf.readUInt16LE(21+2*i);}
   if(bit&&a===0){bits[1]=bits[0];if(bits[0]){regs[6]=regs[2];regs[7]=1;regs[8]=3;bits[5]=true;regs.splice(40,16,...regs.slice(20,36));}}}
  const out=Buffer.alloc(11+payload.length);out[0]=0xd0;buf.copy(out,2,2,7);out.writeUInt16LE(payload.length+2,7);payload.copy(out,11);s.end(out);
 });});await listen(server,0);t.after(()=>new Promise(r=>server.close(r)));
 const p={...initial(),source:'native',port:server.address().port,native:{...defaults,driver:'mc3e'}},wire=connectWire(p,0);
 assert.equal((await wire.state()).boot,7);await wire.physical('estop',true);assert.equal(bits[11],true);
 const {readKnown}=require('../src/assist.cjs');assert.match((await readKnown(p,{modbus:0},'M11')).detail,/= true/);
 assert.match((await readKnown(p,{modbus:0},'D12')).detail,/= 7/);await wire.physical('estop',false);assert.equal(bits[11],false);
 assert.equal(await wire.request(1,'MC_TEST',17),1);const v=await wire.state();assert.equal(v.task_seq,'MC_TEST');assert.equal(v.busy,true);assert.equal(regs[4],17);assert.equal(bits[0],false);
});
test('S7 DB 映射：跨字节的 BOOL、不同 DB 偏移及字数组',async()=>{
 const tags=[],values={'DB7,BYTE11.2':[128,1],'DB8,WORD206.2':[12,34]};
 const fake={removeItems(){},addItems(tag){this.tag=tag;},readAllItems(cb){cb(false,{[this.tag]:values[this.tag]});},writeItems(tag,value,cb){tags.push([tag,value]);cb(false);}};
 const p={...initial(),source:'native',native:{...defaults,driver:'s7',bitDB:7,wordDB:8,bitByte:10,wordByte:200}};
 const wire=new S7Wire(p,0);wire.operation=run=>run(fake);
 assert.deepEqual(await wire.read(1,15,2),[true,true]);assert.deepEqual(await wire.read(3,3,2),[12,34]);
 await wire.physical('estop',true);await wire.words(2,[14,25]);assert.deepEqual(tags,[['DB7,X11.3',true],['DB8,WORD204.2',[14,25]]]);
});
test('提交后链路中断，锁住后续请求，只按原应答号核对一次',async()=>{
 const p=initial(),wire=connectWire(p,0),regs=Array(96).fill(0);let valid=false,mark=true,replyNo=0,replyCode=0;regs[0]=1;regs[8]=1;regs[12]=9;
 wire.read=async(fc,a,n)=>{if(fc===3&&a===6)return [replyNo,replyCode];return fc===3?regs.slice(a,a+n):a===0?[valid,valid]:[valid];};
 wire.words=async(a,v)=>{regs.splice(a,v.length,...v);};wire.coil=async(a,v)=>{valid=v;if(v){replyNo=regs[2];replyCode=1;if(mark)throw Error('应答链路中断');}};
 await assert.rejects(()=>wire.request(1,'UNCERTAIN',2),/已提交/);const saved=wire.uncertain.requested;await assert.rejects(()=>wire.request(1,'NEW',2),/上一请求/);
 replyNo=saved===1?2:1;await assert.rejects(()=>wire.reconcile(),/未读到/);replyNo=saved;mark=false;assert.match(await wire.reconcile(),/已核对/);assert.equal(valid,false);assert.equal(wire.uncertain,null);
});
