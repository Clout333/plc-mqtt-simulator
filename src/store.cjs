'use strict';
const fs=require('node:fs'),path=require('node:path');
// 同目录临时文件＋替换，避免写了一半的JSON被当作正常记录。
// 真正断电可靠性仍取决于操作系统和硬盘，不能替代PLC保持区验收。
function writeJSON(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.tmp';
  const fd=fs.openSync(temp,'w');
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
function readJSON(file,fallback){
  if(!fs.existsSync(file))return structuredClone(fallback);
  try{return JSON.parse(require('../web/local-text.js').decode(fs.readFileSync(file)));}catch(e){throw Error('保存文件损坏，未自动清空：'+file+'；'+e.message);}
}
module.exports={writeJSON,readJSON};
