'use strict';
const path=require('node:path'),{execFile}=require('node:child_process');
let result,ongoing;
function inventory(root){
  if(process.platform!=='win32')return Promise.resolve({items:[],note:'可手动选择工程品牌。'});
  if(result&&Date.now()-result.time<30000)return Promise.resolve(result);
  if(ongoing)return ongoing;
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=path.join(root,'tools','discover-software.ps1');
  // 只执行本平台随包固定脚本。Windows PowerShell 5 用 BOM 识别脚本里的中文。
  ongoing=new Promise(resolve=>execFile(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],
    {windowsHide:true,timeout:9500,maxBuffer:65536,encoding:'utf8'},(error,out)=>{
      let items=[];let note='软件信息用于推荐接法，连接结果以只读检测为准。';
      try{if(error)throw error;items=JSON.parse(out.trim().replace(/^\uFEFF/,'')).items;if(!Array.isArray(items))throw Error();}
      catch{note='未取得完整的软件清单，可手动选择工程类型。';}
      result={items,time:Date.now(),note};resolve(result);
    })).finally(()=>{ongoing=null;});
  return ongoing;
}
module.exports={inventory};
