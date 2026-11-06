'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const format = require('../web/report-format.js');
const {version:appVersion} = require('../package.json');
const day = 86400000;
const limits = {age:30*day, files:12, bytes:256*1024, exported:600};
const segmentPattern = /^events-\d{13}-[\da-f-]{36}-\d+\.jsonl$/;

// 在线路异常与配置错误之间给维护者一个可比较的分类，不把错误原文、IP 或路径收进报告。
function reason(error) {
  const message = String(error?.code || '')+' '+String(error?.message || error || '');
  const rules = [
    [/EADDRINUSE|端口.*占用/,'port'],[/ECONNREFUSED|连接被拒绝/,'refused'],[/ETIMEDOUT|超时|timed out/i,'timeout'],
    [/EACCES|EPERM|无读取权限|无访问权限/,'permission'],[/找不到|ENOENT|MODULE_NOT_FOUND|没有找到|需要Node|需要Node.js/,'missing'],
    [/ENOSPC|EIO|只读|EROFS/,'storage'],[/损坏|保存格式不符|项目库格式/,'corrupt'],[/异常码 11|站号/,'unit'],
    [/点表|寄存器|位地址|DB\d+|地址超出|异常码 2/,'address'],[/断开|断电|离线|ENETUNREACH|ECONNRESET/,'offline'],
    [/待核对|先核对|已提交|提交后/,'uncertain'],[/忙|请先结束|正在处理|执行任务|任务期间/,'busy'],
    [/设备编号|客户端编号/,'device'],[/主题|订阅/,'topic'],[/回执/,'receipt'],[/停用/,'disabled'],
    [/参数|不支持|非法|格式|范围|需|请填|配置|不符|JSON|invalid/i,'config']
  ];
  return rules.find(([pattern])=>pattern.test(message))?.[1] || 'unexpected';
}
function context(p) {
  if(!p) return {};
  const series=p.guide?.kit;
  return format.fields({plc:p.plc,hmi:p.hmi,series:p.source==='native'?series:undefined,
    driver:p.source==='model'?'modbus':p.native?.driver||'modbus',source:p.source,
    owner:p.owner,receiver:p.receiver,mode:p.startMode});
}
function browser(ua=''){
  for(const [name,re] of [['Edge',/Edg\/(\d+)/],['Firefox',/Firefox\/(\d+)/],['Chrome',/Chrome\/(\d+)/],['Safari',/Version\/(\d+).*Safari\//]]) {
    const hit=re.exec(ua);if(hit) return {browser:name,browserMajor:Number(hit[1])};
  }
  return {browser:'Other'};
}
class Journal {
  constructor(dataDir, policy=limits) {
    this.dir=path.join(dataDir,'diagnostics');this.policy={...limits,...policy};this.next=0;this.segment=0;
    this.recent=[];this.seen=new Map();this.available=true;this.installation=randomUUID();
    this.run=format.cleanRun({id:randomUUID(),app:appVersion,os:process.platform,arch:process.arch,
      build:String(os.release()).match(/^\d+(?:\.\d+){0,3}/)?.[0],node:process.versions.node});
    try {
      fs.mkdirSync(this.dir,{recursive:true});
      const identity=path.join(this.dir,'installation.id');
      try {fs.writeFileSync(identity,this.installation,{flag:'wx'});} catch(e) {if(e.code!=='EEXIST')throw e;}
      const saved=fs.readFileSync(identity,'utf8').trim();
      if(!format.uuid.test(saved)) throw Error('invalid installation id');
      this.installation=saved;this.trim();
    } catch {this.available=false;}
  }
  files(){
    return fs.readdirSync(this.dir,{withFileTypes:true}).filter(e=>e.isFile()&&segmentPattern.test(e.name))
      .map(e=>{const file=path.join(this.dir,e.name);return {file,stat:fs.statSync(file)}})
      .sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs||b.file.localeCompare(a.file));
  }
  trim(){
    const cutoff=Date.now()-this.policy.age;
    this.files().forEach(({file,stat},i)=>{if(i>=this.policy.files||stat.mtimeMs<cutoff)fs.rmSync(file,{force:true});});
  }
  record(p,kind,level='info',cause='none',details={},transition='') {
    const time=Date.now(), values={...context(p),...format.fields(details)};
    if(transition){
      const fingerprint=JSON.stringify([level,cause,values]);
      if(this.seen.get(transition)===fingerprint)return;
      this.seen.set(transition,fingerprint);
    }
    const e=format.cleanEvent({run:this.run.id,seq:++this.next,time,kind,level,cause,...values});
    if(!e)return;
    this.recent.push(e);if(this.recent.length>this.policy.exported)this.recent.shift();
    try{
      if(!this.file||this.size>=this.policy.bytes||time-this.opened>day||!fs.existsSync(this.file)){
        this.opened=time;this.file=path.join(this.dir,'events-'+time+'-'+this.run.id+'-'+(++this.segment)+'.jsonl');
        const header=JSON.stringify({run:this.run})+'\n';
        fs.writeFileSync(this.file,header,{flag:'wx'});this.size=Buffer.byteLength(header);
      }
      const line=JSON.stringify(e)+'\n';fs.appendFileSync(this.file,line);this.size+=Buffer.byteLength(line);
      if(this.trimmedFile!==this.file){this.trim();this.trimmedFile=this.file;}
      this.available=true;
    }catch{this.available=false;}
  }
  report() {
    const rows=new Map(), runs=new Map(),cutoff=Date.now()-this.policy.age;let skipped=0;
    const keep=e=>{if(e&&e.time>=cutoff)rows.set(e.run+':'+e.seq,e);};
    try {
      this.trim();
      for(const {file,stat} of this.files().slice(0,this.policy.files)){
        if(stat.size>this.policy.bytes+8192){skipped++;continue;}
        try{
          const lines=fs.readFileSync(file,'utf8').trimEnd().split('\n');
          const run=format.cleanRun(JSON.parse(lines.shift()).run);
          if(!run){skipped++;continue;}runs.set(run.id,run);
          for(const line of lines){
            try{const e=format.cleanEvent(JSON.parse(line));if(e&&e.run===run.id)keep(e);else skipped++;}catch{skipped++;}
          }
        }catch{skipped++;}
      }
    }catch{this.available=false;}
    runs.set(this.run.id,this.run);this.recent.forEach(keep);
    const events=[...rows.values()].sort((a,b)=>b.time-a.time||b.seq-a.seq).slice(0,this.policy.exported);
    const active=new Set(events.map(e=>e.run));
    return {format:'industrial-bench-diagnostics/1',version:appVersion,installation:this.installation,exportedAt:new Date().toISOString(),
      persisted:this.available,skipped,truncated:rows.size>events.length,runs:[...runs.values()].filter(r=>active.has(r.id)),events};
  }
}
module.exports={Journal,limits,browser,reason,appVersion};
