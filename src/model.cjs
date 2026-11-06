'use strict';
const path=require('node:path');
const {writeJSON,readJSON}=require('./store.cjs');
const isId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(s);
class Model {
  constructor(config,dataDir){
    this.config=config;
    this.file=path.join(dataDir,'model.json');
    this.saved=readJSON(this.file,{schema:1,boot:0,results:[],seenTasks:[],active:null});
    if(this.saved.schema!==1||!Array.isArray(this.saved.results)||!Array.isArray(this.saved.seenTasks))throw Error('PLC模型保存格式不符');
    this.inputs={enable:false,reset:false,estop:false,permit:true};
    this.enabled=false;this.fault=0;this.maintenance=false;this.active=this.saved.active;
    // 重启不恢复输出；保留已有任务身份，将未完成任务按本例规则结算。
    if(this.active)this.finish('进程重启中断');
    this.saved.boot=this.saved.boot%65535+1;
    this.active=null;this.commit();this.checkpoint=0;
  }
  commit(){this.saved.active=this.active;writeJSON(this.file,this.saved);}
  get busy(){return this.active!==null;}
  get phase(){return this.active?.phase||1;}
  get startPermitted(){return this.config.requireEnable===false||this.enabled;}
  get canStart(){return this.startPermitted&&!this.fault&&!this.inputs.estop&&this.inputs.permit&&!this.busy&&!this.maintenance;}
  physical(changes){
    for(const [k,v] of Object.entries(changes))if(!(k in this.inputs)||typeof v!=='boolean')throw Error('物理输入必须为已定义的布尔量');
    const before={...this.inputs};Object.assign(this.inputs,changes);
    if(this.inputs.estop){this.fault|=1;this.enabled=false;this.finish('急停');}
    if(!this.inputs.permit&&this.busy){this.fault|=2;this.enabled=false;this.finish('运行许可丢失');}
    if(this.inputs.reset&&!before.reset&&!this.inputs.estop&&this.inputs.permit&&!this.busy){this.fault=0;this.enabled=false;}
    if(this.inputs.enable&&!before.enable&&!this.fault&&!this.inputs.estop&&this.inputs.permit)this.enabled=true;
    return this.state();
  }
  setMaintenance(value){
    if(typeof value!=='boolean')throw Error('维护值须为布尔量');
    if(value&&this.busy)return 11;
    this.maintenance=value;return 1;
  }
  request(op,task,duration,recipe=null){
    if(op===1){
      if(this.maintenance)return 17;
      if(this.fault||this.inputs.estop||!this.inputs.permit)return 14;
      if(!this.startPermitted)return 10;
      if(this.busy)return 11;
      if(!isId(task)||!Number.isInteger(duration)||duration<1||duration>3600)return 12;
      if(this.saved.seenTasks.includes(task))return 16;
      this.active={task_seq:task,recipe:structuredClone(recipe),target:duration,elapsed:0,phase:this.config.prepareSeconds>0?2:3,phaseElapsed:0,started:Date.now(),reason:'正常完成'};
      this.saved.seenTasks.push(task);this.commit();return 1;
    }
    if(op===2){
      if(this.maintenance)return 17;
      if(!this.active||task!==this.active.task_seq)return 15;
      if(this.active.phase!==4){this.active.reason='提前结束';this.active.phase=4;this.active.phaseElapsed=0;if(this.config.finishSeconds===0)this.finish('提前结束');else this.commit();}
      return 1;
    }
    if(op===3){this.physical({reset:false});this.physical({reset:true});this.physical({reset:false});return this.fault?14:1;}
    if(op===4)return this.setMaintenance(true);
    if(op===5)return this.setMaintenance(false);
    return 12;
  }
  advance(seconds){
    if(!Number.isFinite(seconds)||seconds<0)throw Error('时间增量必须为非负有限数');
    let left=seconds;
    while(this.active&&left>0){
      const a=this.active;
      const target=a.phase===2?this.config.prepareSeconds:a.phase===3?a.target:this.config.finishSeconds;
      const use=Math.min(left,Math.max(0,target-a.phaseElapsed));
      a.phaseElapsed+=use;left-=use;if(a.phase===3)a.elapsed+=use;
      if(a.phaseElapsed+1e-9>=target){
        if(a.phase===4){this.finish(a.reason);break;}
        a.phase++;a.phaseElapsed=0;
        if(a.phase===4&&this.config.finishSeconds===0){this.finish(a.reason);break;}
        this.commit();
      }else break;
    }
    this.checkpoint+=seconds;
    if(this.active&&this.checkpoint>=1){this.commit();this.checkpoint=0;}
  }
  finish(reason){
    if(!this.active)return;
    const a=this.active;
    this.saved.results.push({task_seq:a.task_seq,recipe:structuredClone(a.recipe),actual_seconds:Math.round(a.elapsed*1000)/1000,target_seconds:a.target,reason,started:a.started,ended:Date.now()});
    this.saved.results=this.saved.results.slice(-this.config.historyLimit);
    this.active=null;this.commit();
  }
  state(){
    const a=this.active;
    // 这是通用软件时序模型。旧配置可带 basis 描述，工艺专用 PLC 程序在厂商运行端执行。
    return {simulation:true,...(this.config.modelBasis?{basis:this.config.modelBasis}:{}),boot:this.saved.boot,inputs:{...this.inputs},enabled:this.enabled,fault:this.fault,maintenance:this.maintenance,busy:this.busy,can_start:this.canStart,running:this.phase,task_seq:a?.task_seq||'',recipe_name:a?.recipe?.recipe_name||'',elapsed_seconds:a?.elapsed||0,target_seconds:a?.target||0,progress:!a?0:a.phase===2?0:a.phase===4?100:Math.min(100,Math.floor(a.elapsed/a.target*100)),output_run:!!a&&!this.fault,output_work:a?.phase===3&&!this.fault,results:structuredClone(this.saved.results)};
  }
}
module.exports={Model,isId};
