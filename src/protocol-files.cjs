'use strict';
const path = require('node:path');
const {decode} = require('../web/local-text.js');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 900000;
const formats = new Set(['csv','tsv','xls','xlsx','doc','docx','pdf','txt','md','json']);
function formatOf(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!formats.has(ext)) throw Error('请选择 Excel、CSV、TSV、Word、PDF、TXT、Markdown 或 JSON 文件');
  return ext;
}
// 检查 Office 压缩容器的声明大小，解析过程另有独立的内存和时间上限。
async function checkOfficeZip(data) {
  const zip = require('yauzl');
  return new Promise((resolve,reject) => zip.fromBuffer(data,{lazyEntries:true},(err,file) => {
    if (err) return reject(Error('Office 文件结构不完整，请重新保存'));
    let bytes = 0, entries = 0;
    file.on('error',reject).on('end',resolve).on('entry',item => {
      bytes += item.uncompressedSize;
      if (++entries > 4096 || bytes > 48 * 1024 * 1024 || (item.generalPurposeBitFlag & 1)) {
        file.close(); reject(Error('Office 文档过大或已加密，请分成小文件或另存未加密副本')); return;
      }
      file.readEntry();
    });
    file.readEntry();
  }));
}
function sheetBlocks(data, ext) {
  const xlsx = require('xlsx');
  const delimited = ext === 'csv' || ext === 'tsv';
  const book = xlsx.read(delimited ? decode(data) : data, {
    type: delimited ? 'string' : 'buffer', ...(delimited ? {FS:ext === 'tsv' ? '\t' : ',', raw:true} : {}),
    sheetRows: 2001, cellFormula:false, cellHTML:false, cellStyles:false, bookVBA:false
  });
  if (book.SheetNames.length > 32) throw Error('工作表超过 32 张，请按协议拆分文件');
  return book.SheetNames.map(name => {
    const sheet = book.Sheets[name];
    const range = xlsx.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
    if (range.e.r > 1999 || range.e.c > 127) throw Error('每张表最多读取 2000 行、128 列，请只保留协议区域');
    const rows = xlsx.utils.sheet_to_json(sheet,{header:1,raw:false,defval:'',blankrows:true});
    return {label:delimited ? '表格' : name,rows, text:''};
  });
}
function joinItems(items) {
  let text = '', end = 0;
  for (const item of items) {
    const gap = item.transform[4] - end;
    if (text && gap > 2 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
    text += item.str;
    end = item.transform[4] + item.width;
  }
  return text.trim();
}
function pdfPage(items, pageNumber, height) {
  const lines = [];
  for (const item of items.filter(i => i.str?.trim()).sort((a,b) => b.transform[5]-a.transform[5])) {
    const y = item.transform[5];
    if (/^\d+$/.test(item.str.trim()) && (y < height*.115 || y > height*.96)) continue;
    const last = lines.at(-1);
    if (last && Math.abs(last.y-y) <= 3) last.items.push(item);
    else lines.push({y,items:[item]});
  }
  for (const line of lines) line.items.sort((a,b)=>a.transform[4]-b.transform[4]);
  // 取表头的实际横坐标，把 Topic 列中因分页版式而折成两行的路径接起来。
  const rows = [];
  const header = lines.findIndex(line => line.items.some(i=>/^(?:topic|主题|发布主题)$/i.test(i.str.trim())) &&
    line.items.some(i=>/^(?:方向|名称|用途|报文|payload|direction|name)$/i.test(i.str.trim())));
  if (header >= 0) {
    const heads = lines[header].items;
    rows.push(heads.map(i=>i.str.trim()));
    let current, prevY=lines[header].y;
    for (const line of lines.slice(header+1)) {
      if (prevY-line.y>43) break;
      prevY=line.y;
      const columns = heads.map(()=>[]);
      for (const item of line.items) {
        let col=heads.length-1;
        while(col>0 && item.transform[4]<heads[col].transform[4]-4) col--;
        columns[col].push(item);
      }
      const cells=columns.map(joinItems);
      if (!current && cells.filter(Boolean).length<2) continue;
      if (current && cells.filter(Boolean).length===1 && cells[0] && cells[0].length>6) break;
      const isNew = !current || (cells.filter(Boolean).length>=3 && cells[0]) ||
        (cells[0] && cells.some(v=>/^\/[\w{]/.test(v)));
      if (isNew) { current=cells;rows.push(current); }
      else for(let i=0;i<cells.length;i++) current[i]+=cells[i];
    }
  }
  return {label:'第 '+pageNumber+' 页',rows,text:lines.map(l=>joinItems(l.items)).join('\n')};
}
async function pdfBlocks(data) {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets=path.join(path.dirname(require.resolve('pdfjs-dist/package.json')),'cmaps')+'/';
  const task=pdf.getDocument({data:new Uint8Array(data),cMapUrl:assets,cMapPacked:true,useSystemFonts:true,isEvalSupported:false,verbosity:0, useWorkerFetch:false});
  try {
    const doc=await task.promise;
    if(doc.numPages>100)throw Error('PDF 超过 100 页，请截取协议章节后再导入');
    const blocks=[]; let chars=0;
    for(let i=1;i<=doc.numPages;i++){
      const page=await doc.getPage(i), content=await page.getTextContent();
      const block=pdfPage(content.items,i,page.getViewport({scale:1}).height);
      chars+=block.text.length;
      if(chars>MAX_TEXT)throw Error('文件文字太多，请仅保留协议章节');
      blocks.push(block);page.cleanup();
    }
    if(!blocks.some(b=>b.text.trim()))throw Error('这份 PDF 没有可读取的文字。请先做文字识别（OCR），或选择原来的 Word 或表格。');
    return blocks;
  } catch(e) {
    if(e.name==='PasswordException')throw Error('PDF 已加密，请先另存未加密副本');
    throw e;
  } finally {await task.destroy();}
}
async function readDocument(bytes, ext) {
  const data=Buffer.from(bytes);
  if (!data.length || data.length>MAX_BYTES) throw Error('请选择有内容且不超过 8 MB 的文件');
  if (['xlsx','docx'].includes(ext) || ext==='xls' && data[0]===0x50 && data[1]===0x4b) await checkOfficeZip(data);
  let blocks;
  if (['xls','xlsx','csv','tsv'].includes(ext)) blocks=sheetBlocks(data,ext);
  else if (ext==='pdf') blocks=await pdfBlocks(data);
  else if (ext==='doc' || ext==='docx') {
    if (ext==='doc' && data[0]!==0xd0) throw Error('请在 Word 中将此文件另存为 .docx 后重试');
    const WordExtractor=require('word-extractor');
    const doc=await new WordExtractor().extract(data);
    blocks=[{label:'正文',text:doc.getBody({filterUnicode:false}),rows:[]}];
  } else blocks=[{label:'正文',text:decode(data),rows:[]}];
  let total=0;
  for(const b of blocks){
    total+=b.text.length+b.rows.reduce((n,row)=>n+row.reduce((s,c)=>s+String(c).length,0),0);
    if(total>MAX_TEXT)throw Error('文档文字太多，请按协议拆分后再导入');
  }
  return blocks;
}
module.exports={MAX_BYTES,formatOf,readDocument};
