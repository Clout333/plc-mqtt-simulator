'use strict';
const net=require('node:net');
const fields=[
 ['coil',0,1,'RequestValid','请求有效','RW'],['coil',1,1,'ReplyValid','应答有效','R'],
 ['coil',2,1,'Enabled','现场使能','R'],['coil',3,1,'Estop','急停输入','R'],['coil',4,1,'Fault','故障锁存','R'],['coil',5,1,'Busy','任务占用','R'],['coil',6,1,'Maintenance','维护状态','R'],
 ['holding',0,1,'Version','接口版本=1','R'],['holding',2,1,'RequestNo','请求号1～65535','RW'],['holding',3,1,'Operation','1开始2结束3复位4入维护5退维护','RW'],['holding',4,1,'Duration','运行目标秒数','RW'],['holding',5,1,'ExpectedBoot','预期启动代次','RW'],['holding',6,1,'ReplyNo','应答号','R'],['holding',7,1,'ReplyCode','受理码','R'],['holding',8,1,'Phase','1空闲2准备3运行4结束处理','R'],['holding',9,1,'ElapsedTenths','实际运行0.1秒','R'],['holding',10,1,'Progress','进度0～100','R'],['holding',11,1,'ResultCount','保留结果条数','R'],['holding',12,1,'Boot','PLC启动代次','R'],['holding',13,1,'Target','目标秒数','R'],['holding',20,16,'RequestTask','任务号ASCII32字节，高字节在前','RW'],['holding',40,16,'ActiveTask','当前任务号ASCII32字节','R']
];
class Bank {
  constructor(model,config){this.m=model;this.c=config;this.req=new Uint16Array(96);this.valid=false;this.reply=false;this.replyNo=0;this.replyCode=0;}
  pointTable(){return fields.map(([area,offset,width,name,meaning,access])=>({area,address:offset+(area==='coil'?this.c.modbus.coilBase:this.c.modbus.holdingBase),width,name,meaning,access}));}
  coils(){const s=this.m.state();return [this.valid,this.reply,s.enabled,s.inputs.estop,!!s.fault,s.busy,s.maintenance,false,false,false,false,false,false,false,false,false];}
  registers(){
    const a=Array.from(this.req),s=this.m.state();
    Object.assign(a,{0:1,6:this.replyNo,7:this.replyCode,8:s.running,9:Math.round(s.elapsed_seconds*10),10:s.progress,11:s.results.length,12:s.boot,13:s.target_seconds});
    const b=Buffer.alloc(32);b.write(s.task_seq,0,32,'ascii');for(let i=0;i<16;i++)a[40+i]=b.readUInt16BE(i*2);
    return a;
  }
  submit(value){
    if(!value){this.valid=false;this.reply=false;return;}
    this.valid=true;if(this.reply)return;
    const b=Buffer.alloc(32);for(let i=0;i<16;i++)b.writeUInt16BE(this.req[20+i],i*2);
    const task=b.toString('ascii').replace(/\0.*$/s,'');
    this.replyNo=this.req[2];
    const nul=b.indexOf(0),invalid=b.some(v=>v>127)||(nul>=0&&b.subarray(nul).some(v=>v!==0));
    this.replyCode=this.req[2]===0||invalid?12:this.req[5]!==this.m.saved.boot?13:this.m.request(this.req[3],task,this.req[4]);
    this.reply=true;
  }
  pdu(p,unit){
    const fc=p[0];const fail=code=>Buffer.from([fc|128,code]);
    if(unit!==this.c.unitId)return fail(11);
    if(![1,3,5,6,15,16].includes(fc))return fail(1);
    if(p.length<5)return fail(3);
    const address=p.readUInt16BE(1),n=p.readUInt16BE(3),coil=[1,5,15].includes(fc);
    const offset=address-(coil?this.c.modbus.coilBase:this.c.modbus.holdingBase);
    if([1,3].includes(fc)){
      if(p.length!==5||n<1||n>(fc===1?2000:125))return fail(3);
      const values=fc===1?this.coils():this.registers();if(offset<0||offset+n>values.length)return fail(2);
      const out=Buffer.alloc(2+(fc===1?Math.ceil(n/8):n*2));out[0]=fc;out[1]=out.length-2;
      for(let i=0;i<n;i++){if(fc===1){if(values[offset+i])out[2+(i>>3)]|=1<<(i%8);}else out.writeUInt16BE(values[offset+i],2+i*2);}
      return out;
    }
    let count=1,values;
    if(fc===5){if(p.length!==5||![0,65280].includes(n))return fail(3);values=[n===65280];}
    if(fc===6){if(p.length!==5)return fail(3);values=[n];}
    if([15,16].includes(fc)){
      count=n;const bytes=fc===15?Math.ceil(n/8):n*2;
      if(n<1||n>(fc===15?1968:123)||p.length!==6+bytes||p[5]!==bytes)return fail(3);
      values=Array.from({length:n},(_,i)=>fc===15?!!(p[6+(i>>3)]&(1<<(i%8))):p.readUInt16BE(6+i*2));
    }
    // 整批先检查，不能前几个地址写成功、后面失败后留下半份参数。
    for(let i=0;i<count;i++){
      const o=offset+i;
      if(coil?o!==0:!([2,3,4,5].includes(o)||(o>=20&&o<=35)))return fail(2);
    }
    if(!coil&&this.valid)return fail(6);
    if(coil)this.submit(values[0]);else for(let i=0;i<count;i++)this.req[offset+i]=values[i];
    return p.subarray(0,5);
  }
}
function createModbus(bank){
  const sockets=new Set();let online=true;
  const server=net.createServer(socket=>{
    if(!online){socket.destroy();return;}
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let buf=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buf=Buffer.concat([buf,chunk]);if(buf.length>8192){socket.destroy();return;}
      while(buf.length>=7){
        const len=buf.readUInt16BE(4);
        if(buf.readUInt16BE(2)!==0||len<2||len>254){socket.destroy();return;}
        if(buf.length<len+6)return;
        const frame=buf.subarray(0,len+6);buf=buf.subarray(len+6);
        let result;
        try{result=bank.pdu(frame.subarray(7),frame[6]);}catch{result=Buffer.from([frame[7]|128,4]);}
        const reply=Buffer.alloc(7+result.length);reply.writeUInt16BE(frame.readUInt16BE(0));reply.writeUInt16BE(result.length+1,4);reply[6]=frame[6];result.copy(reply,7);socket.write(reply);
      }
    });
  });
  return {server,setOnline(value){online=value;if(!value)for(const s of sockets)s.destroy();},get online(){return online;},close(){for(const s of sockets)s.destroy();return new Promise(resolve=>server.close(resolve));}};
}
module.exports={Bank,createModbus,fields};
