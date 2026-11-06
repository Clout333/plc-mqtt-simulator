'use strict';

const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');

// URL 只由已校验的本机端口、内部启动编号和固定路由构成。绝不把用户输入交给 CMD。
function openDefault(url) {
  const win = process.platform === 'win32';
  const command = win ? path.join(process.env.SystemRoot || 'C:\\Windows','System32','cmd.exe')
    : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const args = win ? ['/d','/s','/c','start "" "'+url+'"'] : [url];
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,windowsVerbatimArguments:win,stdio:'ignore',timeout:4000});
    child.once('error',reject);
    child.once('close',code=>code===0 ? resolve() : reject(Error('系统未能打开默认浏览器')));
  });
}

function installedBrowser() {
  if(process.platform!=='win32')return null;
  const roots=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean);
  for(const [name,relative] of [['Edge','Microsoft/Edge/Application/msedge.exe'],['Chrome','Google/Chrome/Application/chrome.exe']]){
    const file=roots.map(root=>path.join(root,relative)).find(f=>fs.existsSync(f));
    if(file)return {name,open:url=>new Promise((resolve,reject)=>{
      const child=spawn(file,[url],{detached:true,stdio:'ignore'});
      child.once('error',reject);
      child.once('spawn',()=>{child.unref();resolve();});
    })};
  }
  return null;
}

async function waitForPage(statusUrl,instance) {
  const until=Date.now()+8000;
  do {
    try {
      const res=await fetch(statusUrl,{signal:AbortSignal.timeout(650)});
      if(res.ok){
        const status=await res.json();
        if(status.instance===instance&&status.pageReady===true)return true;
      }
    } catch { /* 服务切换或浏览器冷启动时，稍后再读。 */ }
    await sleep(250);
  } while(Date.now()<until);
  return false;
}

async function openPage({port,instance,firstRun},options={}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('网页端口无效');
  const ticket=randomUUID();
  const base='http://127.0.0.1:'+port+'/';
  const page=base+'?launch='+ticket+(firstRun?'#assist':'');
  const statusUrl=base+'health?launch='+ticket;
  const say=options.say||console.log,log=options.log||(()=>{});
  const wait=options.wait||waitForPage;
  async function attempt(kind,name,open){
    say('正在打开'+name+'，等待操作页面就绪…');
    log(kind,'info','none');
    try{await open(page);}catch{log(kind,'warn','missing');return false;}
    if(await wait(statusUrl,instance)){log('ready','pass','none');return true;}
    log(kind,'warn','timeout');return false;
  }
  say('手动访问地址  '+base);
  let confirmed=await attempt('default','默认浏览器',options.openDefault||openDefault);
  if(!confirmed){
    const fallback=(options.fallback||installedBrowser)();
    if(fallback)confirmed=await attempt(fallback.name.toLowerCase(),fallback.name,fallback.open);
  }
  if(confirmed){say('操作页面已打开。关闭本提示窗口后，服务会继续运行。');return true;}
  log('manual','warn','timeout');
  say('尚未收到操作页面的就绪确认。请用 Edge 或 Chrome 手动打开 '+base+' ，无需重新启动服务。');
  return false;
}
module.exports={openPage};
