'use strict';
const fs=require('node:fs'),path=require('node:path');
const {initial,validate}=require('../src/profiles.cjs'),{csv}=require('../src/server.cjs'),{readJSON}=require('../src/store.cjs');
const root=path.resolve(__dirname,'..'),db=readJSON(path.join(root,'data','projects.json'),null);
const p=validate(db?db.profiles.find(x=>x.id===db.active):initial());
const out=path.join(root,'logs','PLC联调点表.csv');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,csv(p));console.log(out);
