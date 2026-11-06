'use strict';
const net=require('node:net');
const {randomInt,randomUUID}=require('node:crypto');
const {Bank}=require('./modbus.cjs');
const {keys,labels}=require('./profiles.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

class BenchBank extends Bank {
  constructor(model,c,profile){super(model,c);this.profile=profile;this.levels=Object.fromEntries(keys.map(k=>[k,false]));}
  pointTable(){return super.pointTable().concat(keys.map(k=>({area:'coil',address:this.profile.physical[k],width:1,name:'Sim_'+k,meaning:'模拟'+labels[k]+(this.profile.buttons[k]?'':'（本项目停用）'),access:'RW'})));}
  input(k,on){
    if(!this.profile.buttons[k]||this.levels[k]===on)return;
    this.levels[k]=on;
    const m=this.m;
    if(k==='estop'||k==='reset'){m.physical({[k]:on});return;}
    if(k==='start'){
      m.physical({enable:on});
      if(on&&this.profile.startMode==='direct'&&m.canStart)m.request(1,'P'+randomUUID().slice(0,22),this.profile.seconds);
    }
    if(k==='stop'&&on&&m.active)m.request(2,m.active.task_seq,0);
  }
  pdu(p,unit){
    if(p[0]===3&&p.length===5&&this.screenCheck){
      const result=super.pdu(p,unit),first=p.readUInt16BE(1)-this.c.modbus.holdingBase;
      if(result[0]===3&&first<=80&&first+p.readUInt16BE(3)>80&&Date.now()<this.screenCheck.expires){
        result.writeUInt16BE(this.screenCheck.value,2+(80-first)*2);this.screenCheck.read=true;
      }
      return result;
    }
    if(unit!==this.c.unitId||p.length<5||![1,5,15].includes(p[0]))return super.pdu(p,unit);
    const fc=p[0],a=p.readUInt16BE(1),count=fc===5?1:p.readUInt16BE(3);
    const map=this.profile.physical;
    if(!keys.some(k=>map[k]>=a&&map[k]<a+count))return super.pdu(p,unit);
    const fail=n=>Buffer.from([fc|128,n]);
    if(count<1||count>(fc===1?2000:1968)||a+count>65536)return fail(3);
    if(fc===1){
      if(p.length!==5)return fail(3);
      const out=Buffer.alloc(2+Math.ceil(count/8));out[0]=1;out[1]=out.length-2;
      const standard=this.coils(),base=this.c.modbus.coilBase;
      for(let i=0;i<count;i++){
        const k=keys.find(k=>map[k]===a+i);
        if(!k&&(a+i<base||a+i>=base+standard.length))return fail(2);
        if(k?this.levels[k]:standard[a+i-base])out[2+(i>>3)]|=1<<(i%8);
      }
      return out;
    }
    if(fc===5&&(p.length!==5||![0,65280].includes(p.readUInt16BE(3))))return fail(3);
    if(fc===15&&(p[5]!==Math.ceil(count/8)||p.length!==6+p[5]))return fail(3);
    const changes=[];
    for(let i=0;i<count;i++){
      const key=keys.find(k=>map[k]===a+i);if(!key)return fail(2);
      changes.push([key,fc===5?!!p.readUInt16BE(3):!!(p[6+(i>>3)]&(1<<(i%8)))]);
    }
    // 同一扫描中优先处理急停，再处理普通按键。
    for(const [k,v] of changes.sort(([a],[b])=>Number(b==='estop')-Number(a==='estop')))this.input(k,v);
    return p.subarray(0,5);
  }
}
function one(port,host,unit,pdu){
  return new Promise((resolve,reject)=>{
    const socket=net.connect({port,host}),tx=randomInt(65536),frame=Buffer.alloc(pdu.length+7);
    frame.writeUInt16BE(tx);frame.writeUInt16BE(pdu.length+1,4);frame[6]=unit;pdu.copy(frame,7);
    let bytes=Buffer.alloc(0),done=false;
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();err?reject(err):resolve(result);};
    const timer=setTimeout(()=>finish(Error('PLC 响应超时')),1000);
    socket.on('error',e=>finish(Error('PLC 连接失败 '+(e.code||e.message))));
    socket.on('close',()=>{if(!done)finish(Error('PLC 提前关闭连接'));});
    socket.on('connect',()=>socket.write(frame));
    socket.on('data',chunk=>{
      bytes=Buffer.concat([bytes,chunk]);if(bytes.length<7)return;
      const len=bytes.readUInt16BE(4);
      if(bytes.readUInt16BE(0)!==tx||bytes.readUInt16BE(2)!==0||bytes[6]!==unit||len<2||len>254)return finish(Error('PLC 响应头不匹配'));
      if(bytes.length<len+6)return;
      const reply=bytes.subarray(7,6+len);
      if(reply[0]===(pdu[0]|128))return finish(Error('Modbus 异常码 '+reply[1]));
      if(reply[0]!==pdu[0])return finish(Error('PLC 功能码不匹配'));
      finish(null,reply);
    });
  });
}
class Wire {
  constructor(p,localPort){this.p=p;this.host=p.source==='model'?'127.0.0.1':p.host;this.port=p.source==='model'?localPort:p.port;this.inFlight=false;this.uncertain=null;}
  frame(fc,a,v){const b=Buffer.alloc(5);b[0]=fc;b.writeUInt16BE(a,1);b.writeUInt16BE(v,3);return b;}
  io(b){return one(this.port,this.host,this.p.unit,b);}
  async read(fc,a,n){
    const b=await this.io(this.frame(fc,a,n)),size=fc===1?Math.ceil(n/8):n*2;
    if(b.length!==size+2||b[1]!==size)throw Error('PLC 数据长度不匹配');
    return Array.from({length:n},(_,i)=>fc===1?!!(b[2+(i>>3)]&(1<<(i%8))):b.readUInt16BE(2+i*2));
  }
  async coil(a,on){const p=this.frame(5,a,on?65280:0),r=await this.io(p);if(!r.equals(p))throw Error('线圈写应答不匹配');}
  async words(a,values){
    const b=Buffer.alloc(6+values.length*2);b[0]=16;b.writeUInt16BE(a,1);b.writeUInt16BE(values.length,3);b[5]=values.length*2;
    values.forEach((v,i)=>b.writeUInt16BE(v,6+i*2));const r=await this.io(b);if(!r.equals(b.subarray(0,5)))throw Error('寄存器写应答不匹配');
  }
  physical(k,on){return this.coil(this.p.physical[k],on);}
  async state(){
    const {coil,holding}=this.p;
    const [bits,r]=await Promise.all([this.read(1,coil,7),this.read(3,holding,56)]);
    if(r[0]!==1||r[12]===0||r[8]<1||r[8]>4||r[10]>100)throw Error('点表签名不符：版本 '+r[0]+'，启动代次 '+r[12]+'，阶段 '+r[8]+'，进度 '+r[10]);
    const task=Buffer.alloc(32);for(let i=0;i<16;i++)task.writeUInt16BE(r[40+i],i*2);
    return {boot:r[12],running:r[8],elapsed_seconds:r[9]/10,progress:r[10],target_seconds:r[13],task_seq:task.toString('ascii').replace(/\0+$/,''),enabled:bits[2],estop:bits[3],fault:bits[4],busy:bits[5],maintenance:bits[6],resultsCount:r[11],replyCode:r[7]};
  }
  async request(op,task='',duration=0){
    if(this.inFlight||this.uncertain)throw Error(this.uncertain?'上一请求结果待核对，请先在接入设置核对应答':'命令通道正在使用');
    if(!/^[A-Za-z0-9_-]{0,32}$/.test(task)||!Number.isInteger(duration)||duration<0||duration>3600)throw Error('PLC 参数超出范围');
    this.inFlight=true;
    let submitted=false,boot=0;
    const {coil,holding}=this.p,requested=randomInt(1,65536);
    try{
      const snapshot=await this.state(),[valid,reply]=await this.read(1,coil,2);
      boot=snapshot.boot;
      if(valid||reply)throw Error('握手区由其他写入端占用');
      const b=Buffer.alloc(32);b.write(task,'ascii');const text=Array.from({length:16},(_,i)=>b.readUInt16BE(i*2));
      const head=[requested,op,duration,snapshot.boot];
      await this.words(holding+2,head);await this.words(holding+20,text);
      const [a,t]=await Promise.all([this.read(3,holding+2,4),this.read(3,holding+20,16)]);
      if(head.some((v,i)=>v!==a[i])||text.some((v,i)=>v!==t[i]))throw Error('参数回读不一致，取消提交');
      submitted=true;await this.coil(coil,true);
      for(let i=0;i<18;i++){
        const [[ack],[n,code]] = await Promise.all([this.read(1,coil+1,1),this.read(3,holding+6,2)]);
        if(ack&&n===requested){await this.coil(coil,false);return code;}
        await wait(55);
      }
      throw Error('PLC 受理应答超时');
    }catch(e){if(submitted){this.uncertain={requested,task,boot};throw Error('已提交，请核对原任务。'+e.message);}throw e;}
    finally{this.inFlight=false;}
  }
  async reconcile(){
    if(!this.uncertain)return '无待核对请求';
    const {requested,boot}=this.uncertain,{coil,holding}=this.p;
    const [[valid,ack],[n,code],[currentBoot]]=await Promise.all([this.read(1,coil,2),this.read(3,holding+6,2),this.read(3,holding+12,1)]);
    if(boot!==currentBoot||n!==requested||!code||!ack&&valid)throw Error('未读到匹配的应答和启动代次，保留待核对状态');
    if(valid)await this.coil(coil,false);
    this.uncertain=null;return '已核对请求 '+n+'，PLC 受理码 '+code;
  }
}
module.exports={BenchBank,Wire,wait};
