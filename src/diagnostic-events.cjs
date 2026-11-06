'use strict';
const {reason}=require('./diagnostics.cjs');
const steps=new Set(['tcp','registers','single','plc','screen','broker','device','topic','reply']);
function operation(route){
  if(route.startsWith('/api/assist/'))return /path|recognise/.test(route)?'files':'screen';
  if(route.startsWith('/api/project/'))return 'project';
  if(route.startsWith('/api/button/'))return 'mqtt';
  if(['/api/physical','/api/hmi','/api/link','/api/reconcile'].includes(route))return 'controls';
  return 'other';
}
function inputKind(route,d){
  if(route==='/api/physical')return ['start','stop','reset','estop'].includes(d.key)?'input.'+(d.key==='estop'&&d.action==='release'?'release':d.key):'api.request';
  if(route==='/api/hmi'&&['start','stop','reset'].includes(d.action))return 'hmi.'+d.action;
  if(route==='/api/assist/screen-confirm')return 'screen.check';
  if(route==='/api/reconcile')return 'plc.reconcile';
  if(route==='/api/link'&&['plc','screen','mqtt'].includes(d.key))return 'link.'+d.key;
  return 'api.request';
}
function checkpoint(journal,p,row,transition){
  if(!steps.has(row.key)||row.status==='skip')return;
  let cause='none',level=row.status;
  if(level==='fail')cause=reason(row.detail);
  if(level==='wait'){
    cause=({screen:'screen',topic:'topic',reply:'receipt',device:'disconnected'})[row.key]||'none';
    if(row.key==='device'&&row.detail.includes('另有客户端')){level='warn';cause='device';}
    if(row.key==='topic'&&row.next?.startsWith('已订阅'))level='warn';
  }
  journal.record(p,'check.'+row.key,level,cause,{},transition?'check.'+row.key:'');
}
function observed(journal,p,route,d,result){
  switch(route){
    case '/api/assist/check':
      result.items.forEach(row=>checkpoint(journal,p,row,true));break;
    case '/api/assist/read':
    case '/api/assist/probe':
      for(const row of [].concat(result))checkpoint(journal,p,row,false);break;
    case '/api/assist/inventory':
      for(const item of result.items)journal.record(p,'software.detect','info','none',{role:item.role,software:item.key,softwareVersion:item.version,running:item.running},'software.'+item.role+'.'+item.key);
      if(!result.items.length)journal.record(p,'software.detect','wait','missing',{},'software.empty');
      break;
    case '/api/assist/recognise':
    case '/api/assist/path':
      journal.record(p,'files.scan',result.candidates.length?'pass':'wait',result.candidates.length?'none':'missing',{count:result.candidates.length});break;
    case '/api/physical': case '/api/hmi':
      {const denied=result.code!==undefined&&result.code!==1,disabled=result.applied===false;
       journal.record(p,inputKind(route,d),denied?'warn':disabled?'info':'pass',denied?'rejected':disabled?'disabled':'none',{plcCode:result.code});}break;
    case '/api/assist/screen-confirm': case '/api/reconcile':journal.record(p,inputKind(route,d),'pass');break;
    case '/api/link':journal.record(p,inputKind(route,d),'info','operator',{running:d.value});break;
  }
}
module.exports={operation,inputKind,observed};
