'use strict';
const net=require('node:net');
const {Wire}=require('./wire.cjs');
const S7=require('nodes7');
const defaults={driver:'modbus',bitDB:100,wordDB:101,bitByte:0,wordByte:0,rack:0,slot:1,localTSAP:0,remoteTSAP:0};
function nativeConfig(p){return {...defaults,...p.native};}
function wordAddress(a,n){return String(a)+(n>1?'.'+n:'');}
class S7Wire extends Wire {
  constructor(p,port){super(p,port);this.cfg=nativeConfig(p);this.tail=Promise.resolve();this.closed=false;}
  async operation(run){
    const next=this.tail.then(async()=>{
      if(this.closed)throw Error('S7 通道已关闭');
      if(!this.client){
        const x=new S7({silent:true}),c=this.cfg;this.client=x;
        const o={host:this.host,port:this.port,rack:c.rack,slot:c.slot,timeout:1100,doNotOptimize:true};
        if(c.localTSAP){o.localTSAP=c.localTSAP;o.remoteTSAP=c.remoteTSAP;}
        try{await new Promise((ok,no)=>x.initiateConnection(o,e=>e?no(Error('S7 连接失败 '+(e.code||e.message||e))):ok()));}
        catch(e){await this.drop();throw e;}
      }
      try{return await run(this.client);}catch(e){await this.drop();throw e;}
    });
    this.tail=next.catch(()=>{});return next;
  }
  async drop(){const x=this.client;this.client=null;if(x)await new Promise(ok=>x.dropConnection(ok));}
  async close(){this.closed=true;await this.tail;await this.drop();}
  read(fc,a,n){
    const c=this.cfg,word=fc===3,offset=word?c.wordByte+a*2:c.bitByte+Math.floor(a/8),count=word?n:Math.ceil(((a%8)+n)/8);
    const tag='DB'+(word?c.wordDB:c.bitDB)+','+(word?'WORD':'BYTE')+wordAddress(offset,count);
    return this.operation(x=>new Promise((ok,no)=>{
      x.removeItems();x.addItems(tag);
      x.readAllItems((bad,values)=>{
        if(bad||!Object.hasOwn(values,tag))return no(Error('S7 读取失败 '+tag));
        const list=count===1?[values[tag]]:Array.from(values[tag]);
        if(list.length!==count)return no(Error('S7 读取长度不匹配'));
        ok(word?list:Array.from({length:n},(_,i)=>!!(list[(i+a%8)>>3]&(1<<((i+a%8)%8)))));
      });
    }));
  }
  write(tag,v){return this.operation(x=>new Promise((ok,no)=>x.writeItems(tag,v,bad=>bad?no(Error('S7 写入失败 '+tag)):ok())));}
  coil(a,on){const c=this.cfg;return this.write('DB'+c.bitDB+',X'+(c.bitByte+Math.floor(a/8))+'.'+a%8,on);}
  words(a,v){const c=this.cfg;return this.write('DB'+c.wordDB+',WORD'+wordAddress(c.wordByte+a*2,v.length),v.length===1?v[0]:v);}
}
// Q/L 兼容设备代码，二进制 3E 帧，ASCII 与 iQ-R 扩展设备编码需另外匹配。
class MCWire extends Wire {
  exchange(bit,write,a,n,payload=Buffer.alloc(0)){
    const req=Buffer.alloc(21+payload.length);req[0]=0x50;req[3]=0xff;req.writeUInt16LE(0x03ff,4);
    req.writeUInt16LE(req.length-9,7);req.writeUInt16LE(12,9);req.writeUInt16LE(write?0x1401:0x0401,11);req.writeUInt16LE(bit?1:0,13);
    req.writeUIntLE(a,15,3);req[18]=bit?0x90:0xa8;req.writeUInt16LE(n,19);payload.copy(req,21);
    return new Promise((ok,no)=>{
      const socket=net.connect(this.port,this.host);let data=Buffer.alloc(0),done=false;
      const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();e?no(e):ok(r);};
      const timer=setTimeout(()=>finish(Error('MC 3E 通信超时')),1100);
      socket.on('error',e=>finish(Error('MC 3E 连接失败 '+(e.code||e.message))));socket.on('close',()=>{if(!done)finish(Error('MC 3E 连接提前关闭'));});
      socket.on('connect',()=>socket.write(req));socket.on('data',b=>{
        data=Buffer.concat([data,b]);if(data.length<9)return;
        const len=data.readUInt16LE(7);if(data[0]!==0xd0||data[1]!==0||!data.subarray(2,7).equals(req.subarray(2,7))||len<2||len>4096)return finish(Error('MC 3E 响应头有误'));
        if(data.length<9+len)return;const code=data.readUInt16LE(9);if(code)return finish(Error('MC 3E 结束码 0x'+code.toString(16).toUpperCase()));
        const result=data.subarray(11,9+len);if(result.length!==(write?0:bit?Math.ceil(n/2):n*2))return finish(Error('MC 3E 响应长度不匹配'));finish(null,result);
      });
    });
  }
  async read(fc,a,n){const bit=fc===1,b=await this.exchange(bit,false,a,n);return Array.from({length:n},(_,i)=>bit?!!(b[i>>1]&(i%2?1:16)):b.readUInt16LE(i*2));}
  coil(a,on){return this.exchange(true,true,a,1,Buffer.from([on?16:0]));}
  words(a,v){const b=Buffer.alloc(v.length*2);v.forEach((n,i)=>b.writeUInt16LE(n,i*2));return this.exchange(false,true,a,v.length,b);}
}
function connectWire(p,port){
  if(p.source==='model')return new Wire(p,port);
  switch(nativeConfig(p).driver){case 's7':return new S7Wire(p,port);case 'mc3e':return new MCWire(p,port);default:return new Wire(p,port);}
}
function nativeTag(p,point){
  if(p.source==='model'||nativeConfig(p).driver==='modbus')return (point.area==='coil'?'C ':'HR ')+point.address;
  const a=point.address,bit=point.area==='coil',c=nativeConfig(p);
  if(c.driver==='mc3e')return (bit?'M':'D')+a;
  return bit?'DB'+c.bitDB+'.DBX'+(c.bitByte+Math.floor(a/8))+'.'+a%8:'DB'+c.wordDB+'.DBW'+(c.wordByte+2*a);
}
module.exports={defaults,nativeConfig,connectWire,nativeTag,S7Wire,MCWire};
