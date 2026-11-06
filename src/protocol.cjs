'use strict';
const path=require('node:path');
const {readJSON,writeJSON}=require('./store.cjs');
const {isId}=require('./model.cjs');
const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable)+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
function object(x){return !!x&&typeof x==='object'&&!Array.isArray(x);}
function recipe(r){
  if(!object(r)||!isId(r.recipe_id)||typeof r.recipe_name!=='string'||r.recipe_name.length<1||r.recipe_name.length>64||!Number.isInteger(r.duration_s)||r.duration_s<1||r.duration_s>3600)throw Error('配方需有效recipe_id、recipe_name及1～3600整数duration_s');
  return {recipe_id:r.recipe_id,recipe_name:r.recipe_name,duration_s:r.duration_s};
}
const reasons={1:'PLC已受理',10:'未物理使能',11:'设备正在执行任务',12:'参数不合法',13:'PLC已重新启动',14:'现场故障或许可不足',15:'任务身份不匹配',16:'该任务已经执行过',17:'设备处于维护调试模式'};
class Protocol {
  constructor(config,model,dataDir){
    this.c=config;this.m=model;this.file=path.join(dataDir,'protocol.json');
    this.data=readJSON(this.file,{schema:1,ledger:[],recipes:[],nextRecipeOrder:0});
    if(this.data.schema!==1||!Array.isArray(this.data.ledger)||!Array.isArray(this.data.recipes))throw Error('协议保存格式不符');
    // 进程异常退出可能停在“先记账、后受理”之间。只核对，不自动补执行。
    for(const row of this.data.ledger.filter(r=>r.reply.processing)){
      if(row.action==='start'&&model.saved.seenTasks.includes(row.task))row.reply={...row.reply,processing:false,success:true,msg:'已从模型任务身份核对受理',recovered:true};
    }
    this.save();
  }
  save(){writeJSON(this.file,this.data);}
  saveRecipe(value){
    const r=recipe(value),old=this.data.recipes.find(x=>x.recipe_id===r.recipe_id);
    const action=!old?'created':stable(recipe(old))===stable(r)?'unchanged':'updated';
    const savedAt=old?.savedAt??Date.now(),order=old?.order??++this.data.nextRecipeOrder;
    this.data.recipes=this.data.recipes.filter(x=>x.recipe_id!==r.recipe_id);
    this.data.recipes.push({...r,savedAt,order});this.data.recipes.sort((a,b)=>a.order-b.order);
    this.data.recipes=this.data.recipes.slice(-this.c.recipeLimit);this.save();return action;
  }
  handle(raw,packet={retain:false}){
    let c,row,maySubmitted=false;
    try{
      if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)throw Error('报文须为不超过16384字节的JSON文本');
      c=JSON.parse(raw);
      if(!object(c)||c.deviceId!==this.c.deviceId||!isId(c.seq))throw Error('设备身份或命令编号不合法');
      if(packet.retain!==false)throw Error('不执行保留的控制消息');
      if(!['start','stop','query'].includes(c.action)||!object(c.params))throw Error('操作或params不合法');
      if(c.action!=='query'&&!isId(c.task_seq))throw Error('任务编号不合法');
      if(c.action==='query'&&c.task_seq!==undefined&&!isId(c.task_seq))throw Error('查询任务编号不合法');
      if(c.action==='start')recipe(c.params.recipe);
      const body=stable({deviceId:c.deviceId,action:c.action,task_seq:c.task_seq??null,params:c.params});
      const prior=this.data.ledger.find(x=>x.seq===c.seq);
      if(prior){if(prior.body!==body)throw Error('同一命令编号包含不同内容');return structuredClone(prior.reply);}
      if(!Number.isSafeInteger(c.timestamp))throw Error('timestamp必须为整数毫秒');
      const age=Date.now()-c.timestamp;
      if(age>this.c.maxCommandAgeSeconds*1000||age< -this.c.futureToleranceSeconds*1000)throw Error('命令已过期或时间超前');
      if(c.action==='query')return {seq:c.seq,success:true,records:structuredClone(this.m.saved.results.filter(r=>!c.task_seq||r.task_seq===c.task_seq))};
      row={seq:c.seq,body,action:c.action,task:c.task_seq,reply:{seq:c.seq,task_seq:c.task_seq,success:false,processing:true,msg:'结果待核对'}};
      this.data.ledger.push(row);this.save();
      let recipeAction;
      const r=c.action==='start'?recipe(c.params.recipe):null;
      // 任务参数是独立快照；配方更新不能悄悄改动运行中的任务。
      if(r&&!this.m.maintenance)recipeAction=this.saveRecipe(r);
      maySubmitted=true;
      const complete=code=>{
        row.reply={seq:c.seq,task_seq:c.task_seq,success:code===1,processing:false,code,msg:reasons[code]||'未知 PLC 应答码',...(recipeAction?{recipe_action:recipeAction}:{})};
        this.save();return structuredClone(row.reply);
      };
      const code=this.m.request(c.action==='start'?1:2,c.task_seq,r?.duration_s||0,r);
      if(code&&typeof code.then==='function')return code.then(complete).catch(e=>({...row.reply,success:null,processing:true,msg:e.message}));
      return complete(code);
    }catch(e){
      if(maySubmitted)return {seq:c.seq,task_seq:c.task_seq,success:false,processing:true,msg:'提交后出错，需核对原任务：'+e.message};
      const rejected={seq:isId(c?.seq)?c.seq:'',task_seq:isId(c?.task_seq)?c.task_seq:'',success:false,processing:false,msg:e.message};
      if(row){row.reply=rejected;try{this.save();}catch{}}
      return rejected;
    }
  }
}
module.exports={Protocol,recipe,reasons};
