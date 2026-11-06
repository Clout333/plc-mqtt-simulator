'use strict';
const net=require('node:net'),path=require('node:path');
const mqtt=require('mqtt');
const {Model}=require('./model.cjs'),{Protocol,reasons}=require('./protocol.cjs');
const {createModbus,fields}=require('./modbus.cjs'),{BenchBank,wait}=require('./wire.cjs');
const {connectWire,nativeTag,nativeConfig}=require('./native.cjs');
const {keys,labels,field}=require('./profiles.cjs'),{readJSON,writeJSON}=require('./store.cjs');
const {randomUUID}=require('node:crypto');
const {commandTopics,filterMatches}=require('./assist.cjs');
const {reason}=require('./diagnostics.cjs');
function listen(server,port){return new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',()=>{server.off('error',no);ok();});});}
function pub(client,topic,raw,qos){return new Promise((ok,no)=>client.publish(topic,raw,{qos,retain:false},e=>e?no(e):ok()));}
function parse(raw){try{return JSON.parse(raw);}catch{return null;}}
function pointTable(p){
  return fields.map(([area,off,width,name,meaning,access])=>({area,address:(area==='coil'?p.coil:p.holding)+off,width,name,meaning,access}))
    .concat(keys.map(k=>({area:'coil',address:p.physical[k],width:1,name:'Sim_'+k,meaning:'模拟'+labels[k]+(p.buttons[k]?'':'（停用）'),access:'RW'})))
    .concat(p.source==='model'?[{area:'holding',address:p.holding+80,width:1,name:'ScreenCheck',meaning:'接入助手验屏，只读无符号16位',access:'R'}]:[])
    .sort((a,b)=>a.area.localeCompare(b.area)||a.address-b.address)
    .map(point=>({...point,native:nativeTag(p,point)}));
}
class Session {
  constructor(base,p,dir,journal){
    this.journal=journal;
    this.base=base;this.p=p;this.dir=dir;this.closed=false;this.attached=false;this.ioCount=0;
    this.c={...base,unitId:p.unit,modbus:{coilBase:p.coil,holdingBase:p.holding},deviceId:p.device,topicPrefix:p.prefix,requireEnable:p.startMode==='enable'&&p.buttons.start};
    this.framesFile=path.join(dir,'frames.json');this.frames=readJSON(this.framesFile,[]);
    this.clients=new Set();this.sockets=new Set();this.subs=new Set();this.pending=new Set();this.localPulses=new Set();
    this.evidenceQueue=[];this.receipts=new Map();this.peerTag=null;
    this.wire=connectWire(p,base.ports.modbus);
    this.lockFile=path.join(dir,'handshake.json');
    const persisted=readJSON(this.lockFile,null);
    this.lockKey=[p.source,this.wire.host,this.wire.port,p.unit,p.coil,p.holding,JSON.stringify(nativeConfig(p))].join('/');
    if(p.source==='native'&&persisted?.key===this.lockKey)this.wire.uncertain=persisted.pending;
    this.lastState=null;this.plcError='正在读取';this.polling=false;this.network=true;this.mqttAllowed=true;this.screenOn=true;
  }
  log(kind,level,cause='none',details={},transition=''){
    if(!this.closed)this.journal?.record(this.p,kind,level,cause,details,transition);
  }
  async init(){
    const {p,c}=this;
    if(p.source==='model'){
      this.model=new Model(c,this.dir);this.bank=new BenchBank(this.model,c,p);this.mb=createModbus(this.bank);
      await listen(this.mb.server,this.base.ports.modbus);
    }
    const {Aedes}=await import('aedes');this.broker=await Aedes.createBroker();
    this.broker.authenticate=(client,u,pw,cb)=>cb(null,client.id!==p.device||this.mqttAllowed&&(p.receiver==='external'||p.owner==='gateway'||this.screenOn));
    this.broker.authorizePublish=(cl,pkt,cb)=>{
      if(pkt.retain)return cb(Error('本地操作台禁用保留消息以避免重放'));
      if(Buffer.byteLength(pkt.payload)>32768)return cb(Error('报文过大'));
      if(cl&&cl===this.peerTag){
        const raw=pkt.payload.toString(),body=parse(raw);
        for(const j of this.evidenceQueue)if(pkt.topic===j.reply&&field(body,j.key)===j.id)j.sourceRaw=raw;
      }
      cb(null);
    };
    const clientIssue=()=>this.log('mqtt.session','warn','peer',{},'mqtt.peer');
    this.broker.on('clientError',clientIssue);this.broker.on('connectionError',clientIssue);
    this.broker.on('client',client=>{if(client?.id===p.device){this.log('mqtt.link','pass','none',{},'mqtt.link');this.peerTag=client;this.subs.clear();this.receipts.clear();this.evidenceQueue=[];}});
    this.broker.on('subscribe',(topics,client)=>{if(client===this.peerTag)for(const v of topics)this.subs.add(v.topic);});
    this.broker.on('unsubscribe',(topics,client)=>{if(client?.id===p.device)for(const v of topics)this.subs.delete(v);});
    this.broker.on('clientDisconnect',client=>{if(client===this.peerTag){this.log('mqtt.link',this.mqttAllowed&&this.screenOn?'warn':'info',this.mqttAllowed&&this.screenOn?'disconnected':'operator',{},'mqtt.link');this.subs.clear();this.peerTag=null;this.receipts.clear();this.evidenceQueue=[];}});
    this.broker.on('publish',(pkt,cl)=>{
      if(this.closed||!cl||pkt.topic.startsWith('$SYS/'))return;
      const raw=pkt.payload.toString(),body=parse(raw);
      let flow='旁路';
      if(cl.id===this.monitorId)flow='下发';
      else if(cl.id===p.device)flow='上行';
      else{
        const resolve=t=>t.replaceAll('{{prefix}}',p.prefix).replaceAll('{{device}}',p.device);
        if(pkt.topic===p.prefix+'command'||this.p.commands.some(c=>resolve(c.topic)===pkt.topic))flow='下发';
        else if(this.p.commands.some(c=>c.replyTopic&&resolve(c.replyTopic)===pkt.topic))flow='上行';
      }
      this.frames.unshift({id:randomUUID(),time:Date.now(),client:cl.id,flow,topic:pkt.topic,qos:pkt.qos,raw,seq:body?.seq??body?.id??''});
      this.frames=this.frames.slice(0,100);this.dirty=true;
    });
    this.tcp=net.createServer(socket=>{this.sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>this.sockets.delete(socket));this.broker.handle(socket);});
    await listen(this.tcp,this.base.ports.mqtt);
    this.monitorId='bench-'+randomUUID().slice(0,12);
    this.monitor=await this.client(this.monitorId,'#',(topic,b)=>{
      const raw=b.toString(),decoded=parse(raw),now=Date.now();
      this.evidenceQueue=this.evidenceQueue.filter(j=>{
        if(j.deadline<now)return false;
        if(j.sourceRaw!==raw||topic!==j.reply||field(decoded,j.key)!==j.id)return true;
        this.receipts.set(j.topic+'\n'+j.reply,{time:now,seq:j.id,success:typeof decoded?.success==='boolean'?decoded.success:null});
        if(this.receipts.size>100)this.receipts.delete(this.receipts.keys().next().value);
        return false;
      });
      for(const job of this.pending){
        if(topic!==job.topic||field(decoded,job.key)!==job.id)continue;
        job.answer({status:'received',payload:decoded});
      }
    });
    if(p.receiver==='builtin'){
      const self=this;
      const facade={get maintenance(){return self.lastState?.maintenance;},get saved(){return self.model?.saved||{seenTasks:[],results:[]};},
        request:(op,task,seconds)=>this.request(op,task,seconds)};
      this.protocol=new Protocol(c,facade,this.dir);
      let serial=Promise.resolve();
      this.device=await this.client(p.device,p.prefix+'command',(topic,b,pkt)=>{
        if(topic!==p.prefix+'command'||this.closed)return;
        this.ioCount++;
        serial=serial.then(async()=>{
          let reply;const raw=b.toString(),cmd=parse(raw);
          if(!this.network)reply={seq:cmd?.seq,success:false,msg:'PLC 通道已断开'};
          else if(!this.model&&cmd?.action==='query')reply={seq:cmd.seq,success:false,msg:'该示例点表仅提供记录条数；请接入项目自己的任务查询接口'};
          else reply=await this.protocol.handle(raw,pkt);
          await pub(this.device,p.prefix+'reply',JSON.stringify({...reply,source:p.owner==='gateway'?'gateway':'hmi'}),1);
        }).catch(e=>{this.deviceError=e.message;this.log('mqtt.session','fail',reason(e),{},'mqtt.handler');}).finally(()=>this.ioCount--);
      });
    }
    await this.refresh();
    let last=performance.now(),lastBeat=0,lastTask=this.model?.saved.results.at(-1)?.task_seq;
    this.tick=setInterval(()=>{
      const now=performance.now();this.model?.advance((now-last)/1000);last=now;
      const result=this.model?.saved.results.at(-1);
      if(result&&lastTask!==result.task_seq){lastTask=result.task_seq;this.report('result',result);}
      if(now-lastBeat>c.heartbeatSeconds*1000){lastBeat=now;this.report('status',{online:!!this.lastState,...(this.lastState||{})});}
    },100);
    this.poll=setInterval(()=>{void this.refresh();if(this.dirty)this.flush();},850);
    return this;
  }
  client(id,subscription,callback){
    const url='mqtt://127.0.0.1:'+this.base.ports.mqtt,client=mqtt.connect(url,{clientId:id,protocolVersion:4,reconnectPeriod:600,connectTimeout:2500,resubscribe:false});
    this.clients.add(client);
    return new Promise((ok,no)=>{
      const timer=setTimeout(()=>no(Error('本地 MQTT 订阅超时')),5000);
      client.on('error',()=>{});client.on('message',callback);
      client.on('connect',()=>client.subscribe(subscription,{qos:2},(err,ack)=>{
        if(err||!ack?.length||ack.some(r=>r.qos>2))return;
        clearTimeout(timer);ok(client);
      }));
    });
  }
  report(t,details){if(this.device?.connected)pub(this.device,this.p.prefix+t,JSON.stringify({deviceId:this.p.device,timestamp:Date.now(),...details}),1).catch(()=>{});}
  async refresh(){
    if(this.closed)return;
    if(!this.polling)this.polling=(async()=>{
      try{if(!this.network)throw Error('PLC 通道已断开');const value=await this.wire.state();if(this.network){this.lastState=value;this.plcError='';}}
      catch(e){this.lastState=null;this.plcError=e.message;}
      this.log('plc.link',this.lastState?'pass':this.network?'fail':'info',this.lastState?'none':this.network?reason(this.plcError):'operator',{},'plc.link');
      if(this.lastState)this.log('plc.phase','info','none',{phase:this.lastState.running},'plc.phase');
    })().finally(()=>{this.polling=false;});
    return this.polling;
  }
  flush(){writeJSON(this.framesFile,this.frames);this.dirty=false;}
  links(){const topics=commandTopics(this.p).filter(t=>t.concrete);return {broker:!!this.tcp?.listening,platform:!!this.monitor?.connected,device:!!this.broker?.clients[this.p.device],subscribed:this.subs.size>0,matched:topics.some(t=>[...this.subs].some(f=>filterMatches(f,t.topic))),subscriptions:[...this.subs],plc:!!this.lastState,plcError:this.plcError,mqttAllowed:this.mqttAllowed,plcAllowed:this.network,screenOn:this.screenOn};}
  snapshot(){return {links:this.links(),plc:this.lastState,physical:this.bank?.levels||null,frames:this.frames.map(({raw,...meta})=>meta),results:this.model?.saved.results||[],pending:this.wire.uncertain,points:pointTable(this.p)};}
  async physical(key,action){
    if(!keys.includes(key))throw Error('未知物理按钮');
    if(!this.p.buttons[key])return {applied:false,message:labels[key]+'在本项目停用'};
    if(!this.network)throw Error('PLC 通道已断开');
    if(this.p.source==='native')await this.wire.state();
    if(key==='estop'){
      if(!['press','release'].includes(action))throw Error('急停需选择按下或释放');
      await this.wire.physical(key,action==='press');
    }else{
      if(action!=='pulse')throw Error('普通按钮使用脉冲');
      if(this.localPulses.has(key))throw Error('该按钮正在发送脉冲');
      this.localPulses.add(key);
      try{
        await this.wire.physical(key,true);await wait(180);
      }finally{
        try{await this.wire.physical(key,false);}finally{this.localPulses.delete(key);}
      }
    }
    return {applied:true,message:key==='estop'?(action==='press'?'急停已按下':'急停已释放，请按复位'):(labels[key]+'脉冲已发出')};
  }
  async request(op,task,seconds){
    if(!this.network)throw Error('PLC 通道已断开');
    const action=({1:'start',2:'stop',3:'reset'})[op]||'other';
    try{const code=await this.wire.request(op,task,seconds);this.log('plc.request',code===1?'pass':'warn',code===1?'none':'rejected',{action,plcCode:code});return code;}
    catch(e){this.log('plc.request','fail',this.wire.uncertain?'uncertain':reason(e),{action});throw e;}
    finally{if(this.p.source==='native'&&this.wire.uncertain)writeJSON(this.lockFile,{key:this.lockKey,pending:this.wire.uncertain});}
  }
  async reconcile(){const message=await this.wire.reconcile();writeJSON(this.lockFile,null);return {message};}
  async hmi(action){
    if(this.p.receiver==='external')throw Error('当前由外部程序持有命令通道，请在该程序操作');
    if(!this.screenOn)throw Error('模拟触摸屏已断电');
    const s=await this.wire.state();
    const op={start:1,stop:2,reset:3}[action];if(!op)throw Error('未知触摸屏操作');
    const task=op===1?'H'+randomUUID().slice(0,20):s.task_seq;
    const code=await this.request(op,task,this.p.seconds);return {code,message:reasons[code]||'受理码 '+code};
  }
  async send(x){
    if(!this.monitor?.connected)throw Error('本地 MQTT 客户端尚未连接');
    let job,reply,timer;
    const started=Date.now(),body=parse(x.raw),action=['start','stop','query','reset'].includes(body?.action)?body.action:'other';
    if(x.replyTopic){
      const id=field(parse(x.raw),x.requestKey);
      if(!['number','string'].includes(typeof id)||id==='')throw Error('业务关联值缺失');
      if([...this.pending].some(j=>j.topic===x.replyTopic&&j.key===x.replyKey&&j.id===id))throw Error('已有相同关联值等待回执');
      if(this.peerTag){
        const now=Date.now();
        this.evidenceQueue=this.evidenceQueue.filter(j=>j.deadline>now).slice(-47);
        this.evidenceQueue.push({topic:x.topic,reply:x.replyTopic,key:x.replyKey,id,deadline:now+x.timeout*1000+1000});
      }
      reply=new Promise(resolve=>{
        job={topic:x.replyTopic,key:x.replyKey,id,answer:resolve};
        this.pending.add(job);timer=setTimeout(()=>resolve({status:'timeout',message:'等待业务回执超时，执行结果待核对'}),x.timeout*1000);
      });
    }
    try{
      await new Promise((ok,no)=>{
        const timer=setTimeout(()=>no(Error('MQTT 发送超时，投递结果待核对')),3500);
        pub(this.monitor,x.topic,x.raw,x.qos).then(()=>{clearTimeout(timer);ok();},e=>{clearTimeout(timer);no(e);});
      });
      const response=reply?await reply:{status:'untracked',message:'此按钮仅观察发送'};
      const proof=this.receipts.get(x.topic+'\n'+x.replyTopic);
      const matched=proof&&proof.time>=started&&proof.seq===job?.id;
      const state=response.status, rejected=response.payload?.success===false;
      const cause=state==='timeout'?'timeout':state==='interrupted'?'uncertain':state==='untracked'?'untracked':!matched?'source':rejected?'rejected':'none';
      this.log('mqtt.message',cause==='none'?'pass':cause==='untracked'?'info':'warn',cause,{action,durationMs:Date.now()-started});
      return {transport:x.qos?'Broker 已确认投递':'客户端已发送（QoS 0）',response,topic:x.topic,raw:x.raw};
    }catch(e){this.log('mqtt.message','fail',reason(e),{action,durationMs:Date.now()-started});throw e;}
    finally{clearTimeout(timer);if(job)this.pending.delete(job);}
  }
  setLink(key,value){
    if(typeof value!=='boolean')throw Error('连接开关需为布尔值');
    if(key==='mqtt'){this.mqttAllowed=value;if(!value)this.broker.clients[this.p.device]?.close();}
    else if(key==='screen'){
      if(this.p.receiver!=='builtin')throw Error('请在外部软件控制屏的运行状态');
      this.screenOn=value;if(!value&&this.p.owner==='hmi')this.broker.clients[this.p.device]?.close();
    }
    else if(key==='plc'){this.network=value;if(this.mb)this.mb.setOnline(value);if(!value){this.lastState=null;this.plcError='PLC 通道已断开';}}
    else throw Error('未知通道');
  }
  async close(){
    this.closed=true;clearInterval(this.tick);clearInterval(this.poll);
    for(const j of this.pending)j.answer({status:'interrupted',message:'服务关闭，执行结果待核对'});
    this.model?.finish('服务停止中断');
    for(const client of this.clients)await new Promise(r=>client.end(true,{},r));
    for(const s of this.sockets)s.destroy();
    if(this.tcp?.listening)await new Promise(r=>this.tcp.close(r));
    if(this.broker)await new Promise(r=>this.broker.close(r));
    if(this.mb)await this.mb.close();
    if(this.wire.close)await this.wire.close();
    if(this.dirty)this.flush();
  }
}
module.exports={Session,listen,pointTable};
