'use strict';
const headers = {
  name:'名称 按钮名称 报文名称 消息名称 功能名称 功能 用途 操作 name title',
  topic:'主题 发布主题 指令主题 消息主题 消息主题topic mqtt主题 topic publishtopic topicname',
  direction:'方向 报文方向 消息方向 收发方向 传输方向 direction flow',
  payload:'报文 报文内容 报文示例 数据示例 消息体 消息内容 消息示例 数据体 内容 payload payload示例 body json 示例报文 示例',
  qos:'qos 建议 建议qos 服务质量 qos等级',
  replyTopic:'回执主题 回复主题 应答主题 响应主题 replytopic responsetopic acktopic',
  requestKey:'指令关联字段 请求关联字段 requestkey', replyKey:'回执关联字段 响应关联字段 replykey',
  format:'报文格式 格式 format'
};
function column(value) {
  const v=String(value).toLowerCase().replace(/[\s_（）():：\-]/g,'');
  return Object.keys(headers).find(k=>headers[k].split(' ').includes(v));
}
function direction(value) {
  const d=String(value||'').toLowerCase().replace(/\s+/g,'');
  if (/下行|下发|平台(?:端)?(?:→|->|到|至)设备|cloud.to.device|^down(link)?$|^c2d$|^command$|^control$|^平台发送$/.test(d))return 'command';
  if (/上行|上报|回执|应答|遗嘱|broker代发|设备(?:端)?(?:→|->|到|至)平台|device.to.cloud|^up(link)?$|^d2c$|^(example|telemetry|report|reply|event)$/.test(d))return 'example';
  return '';
}
function category(label, obj) {
  if (obj && typeof obj==='object') {
    if (Object.hasOwn(obj,'success') || Object.hasOwn(obj,'ack'))return 'reply';
    if (typeof obj.method==='string' && /[.]event[.].*[.]post$/.test(obj.method))return 'report';
    if (typeof obj.method==='string' && /[.]service[.].*[.]set$/.test(obj.method))return 'command';
    if (obj.action || obj.cmd || obj.command)return 'command';
    if (obj.telemetry || obj.status && typeof obj.status==='object')return 'report';
    if (Object.hasOwn(obj,'offline'))return 'offline';
    if (Object.hasOwn(obj,'alarm_word') || obj.alarm)return 'alarm';
    if (obj.finish_reason || Object.hasOwn(obj,'end_time'))return 'result';
  }
  if (/回执|应答|响应|上行指令结果|\breply\b|\back\b|response/i.test(label))return 'reply';
  if (/遗嘱|离线|\boffline\b/i.test(label))return 'offline';
  if (/报警|告警|\balarm\b/i.test(label))return 'alarm';
  if (/作业结果|任务结果上报|task_result/.test(label))return 'result';
  if (/遥测|状态上报|属性上报|telemetry|properties\/report/.test(label))return 'report';
  return '';
}
function topicDirection(value) {
  const t=String(value||'');
  if(/(?:^|[/._-])(?:up|report|telemetry|reply|ack|上报|回执)(?:$|[/._-])|\/event\/[^/]+\/post$/.test(t))return 'example';
  if(/(?:^|[/._-])(?:down|command|commands|invoke|下发)(?:$|[/._-])/.test(t))return 'command';
  return '';
}
function cleanTopic(value) {
  return String(value||'').trim().replace(/^[\x60'"]|[\x60'"]$/g,'')
    .replace(/\/\{productId\}\/\{deviceId\}\//gi,'{{prefix}}')
    .replace(/(?<!\{)\{deviceId\}(?!\})/gi,'{{device}}');
}
function qosOf(value) {
  if (value==null || String(value).trim()==='')return {qos:0,note:'原文未注明 QoS，暂用 0'};
  const m=/^\s*([012])(?:\s|$|\+)/.exec(String(value));
  return m?{qos:Number(m[1]),note:''}:{qos:0,note:'原文 QoS 无法识别，请核对'};
}
function parseJSON(text) {
  try {return {value:JSON.parse(text),repaired:false};}catch{}
  const fixed=text.replace(/([,{:[]\s*)“/g,'$1"').replace(/”(?=\s*[:,}\]])/g,'"');
  try {return {value:JSON.parse(fixed),repaired:true};}catch{return null;}
}
function jsonSamples(text) {
  const found=[];
  for(let i=0;i<text.length;i++){
    if(!['{','['].includes(text[i]) || !/^\s*(?:["“}]|\{)/.test(text.slice(i+1,i+40)))continue;
    let depth=0, quoted=false,escaped=false;
    for(let k=i;k<text.length && k<=i+20000;k++){
      const ch=text[k];
      if(quoted){
        if(escaped)escaped=false;
        else if(ch==='\\')escaped=true;
        else if(ch==='"' || ch==='”' && /^\s*[:,}\]]/.test(text.slice(k+1,k+12)))quoted=false;
        continue;
      }
      if(ch==='"'||ch==='“')quoted=true;
      else if(ch==='{'||ch==='[')depth++;
      else if(ch==='}'||ch===']'){
        if(--depth!==0)continue;
        const raw=text.slice(i,k+1), parsed=parseJSON(raw);
        found.push({start:i,end:k+1,raw,...(parsed||{invalid:true})});i=k;break;
      }
    }
    if(found.length>192)throw Error('报文示例超过 192 条，请按章节拆分文件');
  }
  return found;
}
function table(rows,label,maps,direct) {
  let fields=[],lastTopic='';
  for(let i=0;i<rows.length;i++){
    const cells=rows[i].map(v=>String(v??'').trim()),cols=cells.map(column);
    if(cols.includes('topic') || cols.includes('payload')&&cols.filter(Boolean).length>=2){fields=cols;lastTopic='';continue;}
    if(!fields.length||cells.every(x=>!x||/^:?-+:?$/.test(x)))continue;
    const row={};fields.forEach((key,k)=>{if(key)row[key]=cells[k]||'';});
    const where=label+' · 行 '+(i+1);
    if(row.topic)lastTopic=row.topic;
    if(row.payload){direct.push({...row,topic:row.topic||lastTopic,where});continue;}
    if(row.topic && !/\s/.test(row.topic) && row.topic.length<257 && (row.name||row.direction||fields.includes('qos')))
      maps.push({...row,topic:cleanTopic(row.topic),kind:direction(row.direction)||direction(row.name),where});
  }
}
function textTables(text,label,maps,direct) {
  let group=[],start=0;
  const flush=()=>{if(group.length>1)table(group,label+' · 第 '+start+' 行起',maps,direct);group=[];};
  for(const [i,line] of text.split('\n').entries()){
    const t=line.trim();
    if(!line.includes('\t') && !(/^[|]|[|]$/.test(t)||/^(?:[\w\u3400-\u9fff ]+)\s*\|/.test(t))){flush();continue;}
    if(!group.length)start=i+1;
    group.push(line.includes('\t')?line.split('\t'):t.replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(v=>v.replace(/\\\|/g,'|').replace(/^\s*\x60(.*)\x60\s*$/,'$1')));
  }
  flush();
}
function textBodies(text,label,direct) {
  const lines=text.split('\n');let meta={};
  for(const [i,line] of lines.entries()){
    const match=/^\s*(?:[-*]\s*)?([^=：:]{1,22})[:：=]\s*(.*?)\s*$/.exec(line);
    if(!match)continue;
    const key=column(match[1]),value=match[2];
    if(key==='payload'){
      // JSON 块由跨页扫描器读取。普通文本保留大小写和空格。
      if(value && !/^[{[\x60]/.test(value) && meta.topic)direct.push({...meta,payload:value,format:'text',where:label+' · 行 '+(i+1)});
      meta={};
    }else if(key)meta[key]=value;
  }
}
function metaBefore(text) {
  const result={};
  for(const line of text.split('\n').slice(-25)){
    const m=/^\s*(?:[-*#]+\s*)?([^=：:]{1,22})\s*[:：=]\s*(.*?)\s*$/.exec(line);
    if(m){const key=column(m[1]);if(key&&key!=='payload' && m[2])result[key]=m[2];}
    const heading=/^(?:#{1,5}\s+|[一二三四五六七八九十百]+、\s*)(.+)$/.exec(line.trim());
    if(heading&&!heading[1].includes('....'))result.heading=heading[1];
  }
  return result;
}
function chooseMap(list,kind,cat,name) {
  const maps=list.filter(x=>kind && x.kind===kind);
  const match=maps.filter(x=>(cat&&category(x.name+' '+x.topic)===cat) || (name&&x.name===name));
  const unique=items=>new Set(items.map(x=>x.topic)).size===1?items[0]:null;
  return unique(match)||unique(maps);
}
const actionNames={start:'启动',stop:'停止',query:'查询',reset:'复位',sync_recipe:'同步配方',query_task_result:'查询任务结果'};
const catNames={reply:'指令回执',offline:'离线消息',alarm:'报警上报',result:'任务结果',report:'状态上报'};
function fieldPath(obj) {
  if(!obj||typeof obj!=='object')return '';
  return ['seq','requestId','request_id','correlationId','messageId','流水号','请求编号'].find(k=>Object.hasOwn(obj,k)&&['number','string'].includes(typeof obj[k]))||'';
}
function recognise(blocks) {
  const maps=[], direct=[], candidates=[];
  for(const b of blocks){if(b.rows.length)table(b.rows,b.label,maps,direct);if(b.text){textTables(b.text,b.label,maps,direct);textBodies(b.text,b.label,direct);}}
  const referred=new Set(),refs=new Map();
  function add(row,docSample=false){
    const raw=String(row.payload??''),parsed=row.format==='text'?null:parseJSON(raw);
    const obj=parsed?.value,action=obj?.action||obj?.method||obj?.cmd||obj?.command;
    const cat=category(row.heading||row.name||'',obj);
    const exact=maps.find(x=>x.topic===cleanTopic(row.topic));
    let kind=direction(row.direction)||row.kind||exact?.kind||topicDirection(row.topic)||direction(row.heading);
    if(!kind && cat)kind=cat==='command'?'command':'example';
    const mapping=exact||(!row.topic&&chooseMap(maps,kind,cat,row.name));
    const topic=cleanTopic(row.topic||mapping?.topic);
    if(mapping)referred.add(mapping.topic);
    const name=String(row.name || (typeof action==='string' && (Object.hasOwn(actionNames,action)?actionNames[action]:action)) || catNames[cat] || mapping?.name || '待命名报文').slice(0,36);
    let payload=raw;const note=[];
    if(parsed){
      if(kind==='command' && docSample && obj && !Array.isArray(obj) && typeof obj==='object'){
        if(typeof obj.seq==='string'){obj.seq='{{seq}}';note.push('每次发送生成流水号');}
        if(Number.isSafeInteger(obj.timestamp)&&obj.timestamp>0){obj.timestamp=obj.timestamp<10000000000?'{{timestampSeconds}}':'{{timestamp}}';note.push('发送时填写时间');}
        if(obj.deviceId==='{deviceId}')obj.deviceId='{{device}}';
      }
      payload=JSON.stringify(obj,null,2);
    }
    if(parsed?.repaired||row.repaired)note.push('已修复示例的排版引号，请核对');
    const format=row.format==='text'?'text':(parsed||(row.format||'').toLowerCase()==='json'||/^\s*[{[]/.test(raw)||!raw?'json':'text');
    const q=qosOf(row.qos===''||row.qos==null?mapping?.qos:row.qos);
    if(q.note)note.push(q.note);
    if(!topic)note.push('请填写原协议中的主题');
    if(!raw)note.push('只有主题，请补充报文示例');
    if(format==='json'&&!parsed&&raw)note.push('JSON 需要修正');
    if(!kind||kind==='unknown'){kind='unknown';note.push('请选择报文方向');}
    const retained=row.retain===true||/retain/i.test(String(row.qos||mapping?.qos||''));
    if(retained){note.push('文档注明 retain（保留消息）');if(kind==='command'){kind='unknown';note.push('本台按钮按非保留消息发送，请核对用途');}}
    const key=fieldPath(obj);
    const item={kind,name,topic,format,payload,qos:q.qos,replyTopic:cleanTopic(row.replyTopic),requestKey:row.requestKey||'',replyKey:row.replyKey||'',where:row.where,note:note.join('；')};
    if(cat==='reply'&&topic&&key){if(!refs.has(topic))refs.set(topic,new Set());refs.get(topic).add(key);}
    if(kind==='command'&&key&&!item.requestKey)item.requestKey=key;
    if(candidates.some(c=>c.kind===kind&&c.topic===topic&&c.payload===payload))return;
    if(candidates.length>=96)throw Error('一次最多核对 96 条，请分文件导入');
    candidates.push(item);
  }
  for(const row of direct)add(row);
  let text='';const pages=[];
  for(const b of blocks){
    pages.push({at:text.length,label:b.label});
    text+=b.text.split('\n').map(line=>line.includes('\t')||/^\s*\|.*\|/.test(line)?'':line).join('\n')+'\n';
  }
  const labelAt=pos=>pages.findLast(x=>x.at<=pos)?.label||'正文';
  let lastEnd=0;
  for(const sample of jsonSamples(text)){
    const meta=metaBefore(text.slice(Math.max(lastEnd,sample.start-2600),sample.start));
    lastEnd=sample.end;
    const from=labelAt(sample.start),to=labelAt(sample.end-1),where=from===to?from:from+' 至 '+to;
    if(sample.invalid){if(!direct.length)add({...meta,where,payload:sample.raw,format:'json',kind:'unknown'});continue;}
    for(const v of Array.isArray(sample.value)?sample.value:[sample.value]){
      if(!v||typeof v!=='object'||Array.isArray(v)||!Object.keys(v).length)continue;
      if(v.topic&&typeof v.topic==='string'&&Object.hasOwn(v,'payload')){
        add({...meta,topic:v.topic,where,payload:typeof v.payload==='string'?v.payload:JSON.stringify(v.payload),kind:direction(v.direction)||direction(v.kind),qos:v.qos,retain:v.retain,name:v.name},true);
      }else add({...meta,where,payload:JSON.stringify(v),repaired:sample.repaired},true);
    }
  }
  for(const m of maps)if(!referred.has(m.topic)&&!candidates.some(c=>c.topic===m.topic))add({...m,payload:''});
  for(const c of candidates.filter(c=>c.kind==='command'&&c.requestKey)){
    const matches=[...refs].filter(([topic,keys])=>(!c.replyTopic||topic===c.replyTopic)&&keys.has(c.requestKey));
    if(matches.length===1){c.replyTopic||=matches[0][0];c.replyKey||=c.requestKey;}
    if(c.replyTopic&&!c.replyKey)c.note+=(c.note?'；':'')+'请核对回执关联字段';
  }
  return {candidates,warnings:candidates.length?[]:['未找到报文。请添加主题和 JSON 示例，或使用含“方向、名称、主题、报文”表头的表格。']};
}
module.exports={recognise};
