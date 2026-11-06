'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const XLSX=require('xlsx');
const {readDocument}=require('../src/protocol-files.cjs');
const {recognise}=require('../src/protocol-recognise.cjs');
const {analyse,merge}=require('../src/protocol-import.cjs');
const {decode}=require('../web/local-text.js'),{initial,expand}=require('../src/profiles.cjs');
const {inspectPath}=require('../src/project-files.cjs');
const {fixture,external,end}=require('./bench-fixture.cjs');

const header=['名称','方向','主题','QoS','报文','回执主题','指令关联字段','回执关联字段'];
const sampleRows=[header,['设置泵速','平台→设备','/试验/设定','1','{"数据":{"流水号":"{{seq}}","转速":"{{转速}}"},"备注":"中文，带逗号"}','/试验/应答','数据.流水号','数据.流水号'],
  ['泵速回执','设备→平台','/试验/应答','1','{"数据":{"流水号":"示例"},"结果":"成功"}','','','']];
const expected=r=>{
  assert.equal(r.candidates.length,2);
  const [c,a]=r.candidates;assert.equal(c.kind,'command');assert.equal(a.kind,'example');
  assert.equal(c.name,'设置泵速');assert.equal(c.replyTopic,'/试验/应答');assert.equal(c.qos,1);
  assert.equal(JSON.parse(c.payload).备注,'中文，带逗号');return c;
};
async function read(buf,ext){return recognise(await readDocument(buf,ext));}
for(const type of ['xls','xlsx']){
  test(type+' 多列中文协议表保留方向、JSON、回执字段和 QoS',async()=>{
    const b=XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet(sampleRows),'泵站协议');
    expected(await read(XLSX.write(b,{type:'buffer',bookType:type}),type));
  });
}
test('UTF-8 BOM CSV 与 UTF-16 TSV 保留中文和引号',async()=>{
  const csv=sampleRows.map(c=>c.map(x=>'"'+x.replaceAll('"','""')+'"').join(',')).join('\r\n');
  expected(await read(Buffer.from('\ufeff'+csv),'csv'));
  expected(await read(Buffer.from('\ufeff'+sampleRows.map(c=>c.join('\t')).join('\r\n'),'utf16le'),'tsv'));
});
test('Markdown 表格与 Word 正文表格可按表头识别',async()=>{
  const md=[sampleRows[0],header.map(()=> '---'),...sampleRows.slice(1)].map(r=>'| '+r.join(' | ')+' |').join('\n');
  expected(await read(Buffer.from(md),'md'));
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
  const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'+
    sampleRows.map(r=>'<w:tr>'+r.map(s=>'<w:tc><w:p><w:r><w:t>'+escape(s)+'</w:t></w:r></w:p></w:tc>').join('')+'</w:tr>').join('')+'</w:tbl></w:body></w:document>';
  const zip=XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(zip,'[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  XLSX.CFB.utils.cfb_add(zip,'word/document.xml',Buffer.from(xml));
  expected(await read(XLSX.CFB.write(zip,{type:'buffer',fileType:'zip'}),'docx'));
});
test('TXT 中文键值、纯文本报文、普通 JSON 信封和未知方向',async()=>{
  const t=await read(Buffer.from('名称：泵站开关\n方向：下发\n主题：/控制/开关\n报文：ON'),'txt');
  assert.equal(t.candidates.length,1);assert.equal(t.candidates[0].payload,'ON');assert.equal(t.candidates[0].format,'text');
  const standard=await read(Buffer.from(JSON.stringify({topic:'site/event/property/post',payload:{method:'thing.event.property.post',params:{温度:24}}})),'json');
  assert.equal(standard.candidates[0].kind,'example');
  const incoming={topic:'/试验/温度',direction:'设备→平台',qos:0,payload:{温度:23.5}};
  const result=await read(Buffer.from(JSON.stringify([incoming,{topic:'/甲',payload:{压力:5}}])),'json');
  assert.deepEqual(result.candidates.map(r=>r.kind),['example','unknown']);
  assert.match(result.candidates[1].note,/方向/);
});
test('分开识别跨页指令、回执、排版引号和需要修正的 JSON',()=>{
  const maps=[['用途','Topic','方向','QoS'],['下行','/甲/命令','平台→设备','1'],['回执','/甲/应答','设备→平台','1']];
  const a=recognise([{label:'第 1 页',rows:maps,text:'示例\n{"action":"read","seq":"",\n'},
    {label:'第 2 页',rows:[],text:'"params":{"设备”:"甲"}}\n{"seq":"abc","success":true}\n{"坏字段":2 "未分隔":4}'}]);
  const [d,reply,bad]=a.candidates;assert.equal(d.topic,'/甲/命令');assert.equal(d.replyTopic,'/甲/应答');assert.equal(d.replyKey,'seq');
  assert.match(d.where,/第 1 页 至 第 2 页/);assert.match(d.note,/排版引号/);assert.equal(JSON.parse(d.payload).params.设备,'甲');assert.equal(reply.kind,'example');assert.match(bad.note,/JSON 需要修正/);
});
test('中文编码、中文占位符及保护字段校验',()=>{
  const gb=Buffer.from('d6d0cec4c2b7beb6','hex');assert.equal(decode(gb),'中文路径');
  const be=Buffer.from('\ufeff中文','utf16le').swap16();assert.equal(decode(be),'中文');
  const c=expected(recognise([{label:'甲',rows:sampleRows,text:''}]));
  const p=merge(initial(),[c]).next, cmd=p.commands.at(-1);
  const send=expand(cmd,p,null,{转速:27});assert.equal(JSON.parse(send.raw).数据.转速,27);
  assert.throws(()=>merge(p,[{...c,requestKey:'数据.__proto__'}]),/关联字段/);
  assert.throws(()=>expand(cmd,p,null,JSON.parse('{"__proto__":1}')),/参数名/);
});
test('导入重复、无效批次、跨项目与本机路径边界',async t=>{
  const b=await fixture(t), commands=b.app.state().project.commands.length;
  const data=recognise([{label:'工作簿',rows:sampleRows,text:''}]).candidates;
  await assert.rejects(b.data('/api/protocol/import',{items:[data[0],{...data[1],payload:'?'}]}),/JSON/);
  assert.equal(b.app.state().project.commands.length,commands);
  const a=await b.data('/api/protocol/import',{items:data});assert.deepEqual(a,{added:1,samples:1,skipped:0});
  assert.equal((await b.data('/api/protocol/import',{items:data})).skipped,2);
  const saved=await(await fetch(b.url+'/api/export')).json();assert.equal(saved.project.messageExamples[0].payload,data[1].payload);
  const p=path.join(b.dir,'泵房（甲） & ! # %25.project');
  fs.writeFileSync(p,Buffer.concat([Buffer.from('<?xml version="1.0" encoding="GBK"?><xml manufacturer="'),Buffer.from('bbe3b4a8','hex'),Buffer.from('"/>')]));
  for(const ref of ['“'+p+'”',pathToFileURL(p).href]){
    const info=await inspectPath(ref);assert.equal(info.count,1);assert.ok(JSON.stringify(info).includes('inovance'));
  }
  await assert.rejects(inspectPath('file://other-host/share/示例.project'),/本机/);
  await b.data('/api/protocol/delete-example',{id:saved.project.messageExamples[0].id});
  assert.equal(b.app.state().project.messageExamples.length,0);
});
test('从中文文档导入到本地 MQTT，独立设备按中文字段真实回执',async t=>{
  const b=await fixture(t);await b.save({receiver:'external'});
  const request=await fetch(b.url+'/api/protocol/analyse?type=md',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Bench-Epoch':b.app.state().epoch},body:sampleRows.map(r=>'|'+r.join('|')+'|').join('\n')});
  assert.equal(request.status,200);const rows=(await request.json()).candidates;
  const stale=await fetch(b.url+'/api/protocol/analyse?type=csv',{method:'POST',headers:{'X-Bench-Epoch':'past'},body:'a'});assert.equal(stale.status,409);
  let seen=0;
  const cl=await external(b.c,b.app.state().project.device,['/试验/设定'],(topic,buf,client)=>{
    const obj=JSON.parse(buf);seen++;client.publish('/试验/应答',JSON.stringify({数据:{流水号:obj.数据.流水号},结果:'已设定',转速:obj.数据.转速}),{qos:1});
  });t.after(()=>end(cl));
  await b.data('/api/protocol/import',{items:rows});assert.equal(seen,0);
  const c=b.app.state().project.commands.at(-1),r=await b.button(c.id,{转速:19});
  assert.equal(seen,1);assert.equal(r.response.status,'received');assert.equal(r.response.deviceVerified,true);
  assert.equal(r.response.payload.结果,'已设定');assert.equal(r.response.payload.转速,19);
  const report=JSON.stringify(await(await fetch(b.url+'/api/diagnostics')).json());assert.ok(!report.includes('试验/设定')&&!report.includes('带逗号'));
});
test('扫描件、非协议内容、损坏文件和扩展名返回可操作的提示',async()=>{
  const parts=['%PDF-1.4\n'], offsets=[0];
  for(const body of ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>']){
    offsets.push(parts.join('').length);parts.push((offsets.length-1)+' 0 obj\n'+body+'\nendobj\n');
  }
  const xref=parts.join('').length;
  parts.push('xref\n0 4\n0000000000 65535 f \n'+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF');
  await assert.rejects(analyse(Buffer.from(parts.join('')),'扫描件.pdf'),/OCR/);
  assert.match((await analyse(Buffer.from('操作手册目录'),'手册.txt')).warnings[0],/未找到/);
  await assert.rejects(analyse(Buffer.from('无效'),'坏文件.docx'),/Office|文档/);
  await assert.rejects(analyse(Buffer.from('test'),'文件.exe'),/请选择/);
});
