'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {load}=require('../src/config.cjs');
const {readJSON,writeJSON}=require('../src/store.cjs');
const {openPage}=require('./open-page.cjs');
const root=path.resolve(__dirname,'..'),logs=path.join(root,'logs'),recordFile=path.join(logs,'instance.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=c=>crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
async function health(port){try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(700)});return r.ok?await r.json():null;}catch{return null;}}
function matches(h,r){return h&&r&&h.service==='industrial-device-bench'&&h.projectId===r.projectId&&h.instance===r.instance&&h.pid===r.pid&&h.root===root;}
function dependencies(){
  if(Number(process.versions.node.split('.')[0])<24)throw Error('需要Node.js 24或更高版本，当前为'+process.version);
  try{require.resolve('aedes');require.resolve('mqtt');require.resolve('nodes7');return;}catch{}
  const candidates=[path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),...(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,'node_modules','npm','bin','npm-cli.js'))];
  const npm=candidates.find(p=>fs.existsSync(p));if(!npm)throw Error('没有找到npm；请安装完整Node.js运行时');
  console.log('首次准备锁定依赖，需要可访问npm包源；完成后本机可离线运行。');
  const r=spawnSync(process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:'inherit',windowsHide:true,timeout:240000});
  if(r.error||r.status!==0)throw Error('依赖准备失败：'+(r.error?.message||'请查看npm输出；未启动服务'));
}
function free(port){return new Promise((ok,no)=>{const s=net.createServer();s.once('error',()=>no(Error('端口'+port+'已占用，未停止任何已有程序；请在project.json选择空闲端口')));s.listen(port,'127.0.0.1',()=>s.close(ok));});}
// Windows 会在启动器退出时释放命名管道。连续双击期间只有持有者能创建服务或改写实例记录。
async function lockStartup(){
  if(process.platform!=='win32')return null;
  const key=crypto.createHash('sha256').update(fs.realpathSync(root).toLowerCase()).digest('hex').slice(0,32);
  const pipe='\\\\.\\pipe\\plc-mqtt-start-'+key;
  const deadline=Date.now()+22000;
  do{
    const lock=net.createServer(socket=>socket.destroy());
    try{
      await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(pipe,resolve);});
      return lock;
    }catch(e){if(e.code!=='EADDRINUSE')throw e;}
    await sleep(200);
  }while(Date.now()<deadline);
  throw Error('另一个启动窗口仍在准备服务，请查看那个窗口的提示');
}
async function main(){
  const action=process.argv[2]||'status';fs.mkdirSync(logs,{recursive:true});
  const c=load(root),previous=readJSON(recordFile,null);
  if(action==='status'){
    const h=previous?await health(previous.port):null;
    console.log(JSON.stringify(matches(h,previous)?h:{running:false,msg:'没有本项目已确认的运行实例'},null,2));return;
  }
  if(action==='stop'){
    if(!previous){console.log('没有本项目运行记录。');return;}
    const h=await health(previous.port);
    if(!h){console.log('未发现可确认的本项目服务；没有按旧PID强制结束进程。');return;}
    if(!matches(h,previous))throw Error('该端口不是记录中的本项目实例，未停止');
    const r=await fetch(`http://127.0.0.1:${previous.port}/api/shutdown`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:previous.projectId,instance:previous.instance}),signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw Error('服务未接受停止请求');
    for(let i=0;i<30;i++){await sleep(200);if(!matches(await health(previous.port),previous)){writeJSON(recordFile,{...previous,status:'stopped'});console.log('本项目服务已停止，数据与日志保留。');return;}}
    throw Error('等待停止超时，未强杀任何进程；请查看日志');
  }
  if(action==='test'){
    dependencies();const began=Date.now();
    const r=spawnSync(process.execPath,['--test','tests/model.test.cjs','tests/integration.test.cjs','tests/native.test.cjs','tests/assist.test.cjs','tests/diagnostics.test.cjs','tests/launcher.test.cjs'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
    process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
    writeJSON(path.join(logs,'self-test.json'),{began,ended:Date.now(),node:process.version,scope:'独立临时目录与本机临时端口；不修改用户运行数据',passed:r.status===0,exitCode:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message});
    if(r.status!==0)throw Error('自测未通过，详见logs/self-test.json');
    const {Journal}=require('../src/diagnostics.cjs');new Journal(path.join(root,'data')).record(null,'service.test','pass');return;
  }
  if(action!=='start')throw Error('用法：node tools/control.cjs start [--open] | stop | status | test');
  const lock=await lockStartup();
  let record;
  const firstRun=!fs.existsSync(path.join(root,'data','projects.json'));
  try{record=await startService(c);}finally{if(lock)await new Promise(resolve=>lock.close(resolve));}
  if(process.argv.includes('--open')&&!process.argv.includes('--headless')){
    const {Journal}=require('../src/diagnostics.cjs');
    const journal=new Journal(path.join(root,'data'));
    const confirmed=await openPage({port:record.port,instance:record.instance,firstRun},{
      log:(launchStep,level,cause)=>journal.record(null,'service.launch',level,cause,{operation:'start',channel:'http',launchStep})
    });
    if(!confirmed)process.exitCode=2;
  }
}
async function startService(c){
  dependencies();
  const previous=readJSON(recordFile,null);
  const h=previous?await health(previous.port):null;
  if(matches(h,previous)){
    if(previous.configHash!==hash(c))throw Error('配置已改动，请先停止原实例再启动');
    if(!h.ready)throw Error('本项目实例存在但尚未就绪，请查看日志；未重复启动');
    if(h.version!==require('../package.json').version)throw Error('本目录仍在运行旧版服务。请结束测试，运行 01_停止本项目.cmd 后再启动新版');
    console.log('复用本项目实例：http://127.0.0.1:'+previous.port);return previous;
  }
  for(const [channel,port] of Object.entries(c.ports)){
    try{await free(port);}catch(e){e.diagnosticChannel=channel;throw e;}
  }
  const instance=crypto.randomBytes(24).toString('hex');
  const out=fs.openSync(path.join(logs,'service.log'),'a'),err=fs.openSync(path.join(logs,'service-error.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'src','server.cjs'),'--instance',instance],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  fs.closeSync(out);fs.closeSync(err);
  let spawnError;child.on('error',e=>{spawnError=e;});
  const record={projectId:c.projectId,root,pid:child.pid,instance,port:c.ports.http,configHash:hash(c),created:Date.now()};
  writeJSON(recordFile,record);
  for(let i=0;i<75;i++){
    await sleep(200);if(spawnError)throw spawnError;
    const ready=await health(c.ports.http);
    if(matches(ready,record)&&ready.ready){child.unref();console.log('服务已就绪：http://127.0.0.1:'+c.ports.http);console.log('MQTT '+c.ports.mqtt+'；Modbus TCP '+c.ports.modbus+'；项目与驱动在网页中选择');return record;}
    if(child.exitCode!==null)break;
  }
  // 这是本次直接创建且仍受句柄跟踪的子进程，不按历史PID或进程名清理。
  if(child.exitCode===null&&!spawnError)child.kill();
  throw Error('启动未就绪，详见logs/service-error.log；未影响其他项目进程');
}
main().catch(e=>{
  const {Journal,reason}=require('../src/diagnostics.cjs');const action=process.argv[2];
  new Journal(path.join(root,'data')).record(null,action==='test'?'service.test':'service.launch','fail',reason(e),{operation:action,channel:e.diagnosticChannel});
  console.error(e.message);process.exitCode=1;
});
