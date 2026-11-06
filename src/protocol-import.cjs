'use strict';
const {Worker,isMainThread,parentPort,workerData} = require('node:worker_threads');
const {randomUUID} = require('node:crypto');
const {command,example,validate} = require('./profiles.cjs');
const {readDocument,formatOf} = require('./protocol-files.cjs');

async function analyse(bytes,name) {
  const ext=formatOf(name);
  const data=Uint8Array.from(bytes);
  const worker=new Worker(__filename,{workerData:{ext,data},transferList:[data.buffer],resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32}});
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>finish(reject,Error('读取文档超时，请只保留协议章节再试')),25000);
    function finish(done,value){clearTimeout(timeout);worker.removeAllListeners();void worker.terminate();done(value);}
    worker.once('message',msg=>msg.error?finish(reject,Error(msg.error)):finish(resolve,msg.result));
    worker.once('error',()=>finish(reject,Error('文件无法解析，请检查是否损坏、已加密或太大')));
    worker.once('exit',()=>finish(reject,Error('读取文件中断，请拆分文档再试')));
  });
}
function signature(row) {
  const payload=row.format==='json'?JSON.stringify(JSON.parse(row.payload)):row.payload;
  return JSON.stringify([row.topic,row.format,payload,row.qos,row.replyTopic||'',row.requestKey||'',row.replyKey||'']);
}
function merge(project,items) {
  if(!Array.isArray(items)||!items.length||items.length>96)throw Error('请勾选 1～96 条报文');
  const commands=project.commands.slice(), examples=(project.messageExamples||[]).slice();
  const seenCommands=new Set(commands.map(signature)),seenExamples=new Set(examples.map(signature));
  let added=0,samples=0,skipped=0;
  for(const [index,item] of items.entries()){
    try{
      if(!item||!['command','example'].includes(item.kind))throw Error('请选择报文方向');
      const row={id:randomUUID(),name:item.name,topic:item.topic,format:item.format,payload:item.payload,qos:item.qos};
      if(typeof row.payload!=='string'||!row.payload.trim())throw Error('请填写报文内容');
      const down=item.kind==='command';
      if(down){
        Object.assign(row,{replyTopic:item.replyTopic||'',requestKey:item.requestKey||'',replyKey:item.replyKey||'',timeout:item.timeout??3});
        command(row);
      }else example(row);
      const key=signature(row),seen=down?seenCommands:seenExamples;
      if(seen.has(key)){skipped++;continue;}
      seen.add(key);
      if(down){commands.push(row);added++;}else{examples.push(row);samples++;}
    }catch(e){throw Error('第 '+(index+1)+' 条「'+String(item?.name||'待命名').slice(0,36)+'」：'+e.message);}
  }
  const next=validate({...project,commands,messageExamples:examples});
  return {next,added,samples,skipped};
}
if(!isMainThread && workerData?.ext){
  (async()=>{
    try{
      const blocks=await readDocument(workerData.data,workerData.ext);
      const {recognise}=require('./protocol-recognise.cjs');
      const result=recognise(blocks);
      parentPort.postMessage({result});
    }catch(e){
      // 第三方解析错误可能含原文片段或路径，仅把可操作的中文提示返回给导入窗口。
      parentPort.postMessage({error:/^[\u3400-\u9fff]|^(?:PDF|Office) /.test(e.message)?e.message:'文档结构无法读取。请检查文件是否损坏、已加密，或另存为受支持的格式。'});
    }
  })();
}
module.exports={analyse,merge};
