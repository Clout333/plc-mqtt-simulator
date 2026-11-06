'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {decode}=require('../web/local-text.js'),{fileURLToPath}=require('node:url');
const {recognise}=require('./assist.cjs');
const supported=/\.(gpc|hwdev|(?:z?ap)\d{2}(?:_\d+)?|smart|mwp|gx3|gxw|emtp|cmtp|st|scl|awl|lad|xml|project|mcp|mcgs|hcp|s7p|json|js|ts|lua|py|c|cpp|iecst|il|projectarchive)$/i;
const skip=new Set(['.git','.svn','node_modules','__pycache__','dist','bin','obj','runtime','logs','.venv','venv','packages']);
function vendorHint(s){return [...s.matchAll(/\b(?:companyName|productName|vendor|manufacturer)\s*=\s*["']([^"'<>\r\n]{1,90})["']/gi)].slice(0,6).map(v=>v[1]).join(' ').slice(0,180);}
async function inspectPath(input){
  if(typeof input!=='string'||input.length>1800)throw Error('请输入本机工程文件或文件夹的完整路径');
  let v=input.trim();
  const quotePairs={'"':'"',"'":"'","“":"”","‘":"’"};
  if(quotePairs[v[0]]===v.at(-1))v=v.slice(1,-1);
  if(/^file:/i.test(v)){
    try{const u=new URL(v);if(u.hostname&&u.hostname!=='localhost'||u.search||u.hash)throw Error();v=fileURLToPath(u);}
    catch{throw Error('请使用本机文件的完整路径，或从资源管理器重新复制');}
  }
  if(!path.isAbsolute(v)||/^[\\/]{2}/.test(v)||v.includes('\0')||(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(v)))throw Error('请使用本机磁盘的绝对路径。也可以选择工程文件。');
  let full,stat;
  try{full=await fs.realpath(v);stat=await fs.stat(full);}catch{throw Error('找不到该文件或文件夹，或当前用户无读取权限。请从资源管理器复制完整路径。');}
  if(/^[\\/]{2}/.test(full))throw Error('请选择本机工程副本');
  const home=path.resolve(os.homedir()),blocked=[path.parse(full).root,home,path.join(home,'Desktop'),process.env.SystemRoot].filter(Boolean);
  if(stat.isDirectory()&&blocked.some(x=>path.relative(x,full)===''))throw Error('请指定具体项目文件夹，或直接粘贴工程文件路径。');
  const root=stat.isDirectory()?full:path.dirname(full),files=[];
  let scanned=0,truncated=false,unreadable=0,depthLimited=false,supplementary=0;
  async function add(f){
    if(files.length>=160){truncated=true;return;}
    const name=path.basename(f),label=path.relative(root,f);
    if(stat.isDirectory()&&/\.(json|js|ts|lua|py|c|cpp|st|xml)$/i.test(name)&&++supplementary>48){depthLimited=true;return;}
    let vendor='';
    if(/\.(xml|project|mcgs)$/i.test(name)){
      let handle;
      try{handle=await fs.open(f,'r');const b=Buffer.alloc(24576),n=(await handle.read(b,0,b.length,0)).bytesRead;
        vendor=vendorHint(decode(b.subarray(0,n),n===b.length));}
      catch{unreadable++;}finally{if(handle)await handle.close();}
    }
    files.push({name,label,vendor});
  }
  if(stat.isFile()){await add(full);}
  else if(stat.isDirectory()){
    const queue=[[root,0]];
    while(queue.length&&!truncated){
      const [dir,depth]=queue.shift();let folder;
      try{folder=await fs.opendir(dir);}catch{unreadable++;continue;}
      for await(const item of folder){
        if(++scanned>3500||files.length>=160){truncated=true;break;}
        if(item.isSymbolicLink()||item.name.startsWith('.')||skip.has(item.name.toLowerCase()))continue;
        const target=path.join(dir,item.name);
        if(item.isDirectory()){if(depth<4)queue.push([target,depth+1]);else depthLimited=true;}
        else if(item.isFile()&&supported.test(item.name))await add(target);
      }
    }
  }else throw Error('仅支持普通文件和项目文件夹');
  return {...recognise(files),count:files.length,truncated:truncated||depthLimited,unreadable,origin:path.basename(full)};
}
module.exports={inspectPath,vendorHint};
