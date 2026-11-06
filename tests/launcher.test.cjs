'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {openPage}=require('../tools/open-page.cjs');
const {fixture}=require('./bench-fixture.cjs');

test('默认浏览器打开后，要核对本次页面回执才报告成功',async t=>{
  const app=await fixture(t),lines=[],events=[];
  let launchId;
  const ok=await openPage({port:app.c.ports.http,instance:app.app.instance,firstRun:true},{
    say:v=>lines.push(v),log:(...e)=>events.push(e),
    openDefault:async url=>{
      const u=new URL(url);assert.equal(u.hash,'#assist');assert.equal(u.origin,app.url);
      launchId=u.searchParams.get('launch');
      assert.equal((await (await fetch(app.url+'/health?launch='+launchId)).json()).pageReady,false);
      await app.data('/api/diagnostics/browser',{kind:'open',launch:launchId});
    },
    fallback:()=>assert.fail('页面已就绪时不应再次打开')
  });
  assert.equal(ok,true);assert.ok(lines.some(l=>l.includes('手动访问地址')&&l.includes(app.url)));
  assert.deepEqual(events.map(e=>e[0]),['default','ready']);
  const report=await (await fetch(app.url+'/api/diagnostics')).json();
  assert.ok(report.events.some(e=>e.kind==='browser.open'));assert.ok(!JSON.stringify(report).includes(launchId));
  const another=await (await fetch(app.url+'/health?launch='+randomUUID())).json();assert.equal(another.pageReady,false);
});

test('系统已接收打开请求但页面未就绪，备用浏览器能完成同一次打开',async()=>{
  const seen=[],results=[false,true],events=[];
  const ok=await openPage({port:21410,instance:'test',firstRun:false},{
    say:()=>{},log:(...v)=>events.push(v),openDefault:async url=>{seen.push(url);},
    fallback:()=>({name:'Edge',open:async url=>{seen.push(url);}}),wait:async()=>results.shift()
  });
  assert.equal(ok,true);assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);assert.equal(new URL(seen[0]).hash,'');
  assert.deepEqual(events.map(v=>v.slice(0,2)),[['default','info'],['default','warn'],['edge','info'],['ready','pass']]);
});

test('系统浏览器不可用时给出配置中的网址，服务状态与页面失败分开',async()=>{
  const lines=[],stages=[];
  const ok=await openPage({port:26901,instance:'test',firstRun:false},{
    say:v=>lines.push(v),log:(...v)=>stages.push(v),openDefault:async()=>{throw Error('failed');},
    fallback:()=>null,wait:()=>assert.fail('未启动浏览器时不应等待页面')
  });
  assert.equal(ok,false);assert.equal(stages.at(-1)[0],'manual');
  assert.match(lines.at(-1),/手动打开 http:\/\/127\.0\.0\.1:26901\//);
  assert.ok(!lines.join('').includes('?launch='));assert.ok(!lines.some(l=>l.includes('操作页面已打开')));
});

test('没有页面确认时，即使备用浏览器进程启动也保留手动入口',async()=>{
  let attempts=0;
  const ok=await openPage({port:19860,instance:'test',firstRun:true},{
    say:()=>{},openDefault:async()=>{},fallback:()=>({name:'Chrome',open:async()=>{}}),
    wait:async()=>{attempts++;return false;}
  });
  assert.equal(attempts,2);assert.equal(ok,false);
  await assert.rejects(openPage({port:'19860&echo',instance:'test'}),/端口/);
});
