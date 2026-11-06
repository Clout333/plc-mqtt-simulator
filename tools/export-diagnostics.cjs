'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Journal}=require('../src/diagnostics.cjs');
const root=path.resolve(__dirname,'..');
try{
  const report=new Journal(path.join(root,'data')).report(),folder=path.join(root,'exports');
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'诊断-'+report.exportedAt.replace(/[:.]/g,'-')+'.json');
  fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log('已导出 '+report.events.length+' 条诊断事件\n'+file);
}catch(e){console.error('未能导出诊断报告：'+e.message);process.exitCode=1;}
