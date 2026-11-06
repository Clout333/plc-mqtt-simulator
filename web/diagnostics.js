'use strict';
(() => {
  const fmt=window.BenchReports, el=id=>document.getElementById(id);
  let current=null,summary=null,visible=30,epoch='',started='',busy=false;
  let launch=new URLSearchParams(location.search).get('launch');
  const issues=[],date=t=>new Date(t).toLocaleString('zh-CN',{hour12:false}),label=v=>v?(fmt.labels[v]||v):'';
  function tr(values) {
    const row=document.createElement('tr');
    for(const text of values){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
    return row;
  }
  function feedback(message,bad=false){const n=el('diagNotice');n.className='notice'+(bad?' bad':'');n.textContent=message;n.hidden=!message;}
  function save(name,data){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
  function route(e){
    const desc=[label(e.series||e.plc),label(e.hmi),label(e.driver),label(e.source)];
    if(e.owner)desc.push(label(e.owner)+'接入 MQTT');
    return desc.filter(Boolean).join(' · ');
  }
  function render(){
    if(!current)return;
    const filtered=el('diagProblems').checked?current.events.filter(e=>['warn','fail'].includes(e.level)):current.events;
    const rows=filtered.slice(0,visible).map(e=>{
      const extra=[fmt.causes[e.cause],e.launchStep&&({default:'打开默认浏览器',edge:'尝试 Edge',chrome:'尝试 Chrome',ready:'页面已就绪',manual:'提示手动访问'})[e.launchStep],e.channel&&({http:'网页服务',mqtt:'本机 Broker',modbus:'内置 Modbus'})[e.channel],e.phase&&['','空闲','准备','作业','结束处理'][e.phase],e.plcCode&&('PLC 受理码 '+e.plcCode),e.browser&&(e.browser+' '+(e.browserMajor||'')),
        e.software&&[label(e.software),label(e.role),e.softwareVersion,e.running?'运行中':'已检测到'].filter(Boolean).join(' '),e.count!==undefined&&('检出 '+e.count+' 项'),e.durationMs!==undefined&&(e.durationMs+' ms'),route(e)].filter(Boolean);
      return tr([date(e.time),fmt.events[e.kind],fmt.levels[e.level],extra.join(' / ')||'—']);
    });
    if(!rows.length)rows.push(tr(['—',el('diagProblems').checked?'当前没有提醒或失败':'暂无记录','—','—']));
    el('diagRows').replaceChildren(...rows);el('diagMore').hidden=filtered.length<=visible;
    el('diagCount').textContent='共 '+filtered.length+' 条';
    const last=current.runs.find(r=>r.id===current.events[0]?.run);
    el('diagEnvironment').textContent='软件 v'+current.version+(last?'　'+(last.os==='win32'?'Windows':last.os)+' '+last.build+' '+last.arch+'　Node.js '+last.node:'');
    const notes=[];if(!current.persisted)notes.push('日志目录当前无法写入，请在关闭程序前导出本次记录');
    if(current.skipped)notes.push('部分旧记录损坏，已跳过 '+current.skipped+' 处');if(current.truncated)notes.push('报告取最近 600 条记录');
    feedback(notes.join('。'),!current.persisted||current.skipped>0);
  }
  async function read(){const response=await fetch('/api/diagnostics',{cache:'no-store'});if(!response.ok)throw Error('无法读取运行诊断，请确认本地服务已启动');current=await response.json();render();return current;}
  async function open(){if(busy)return;busy=true;try{await read();}catch(e){feedback(e.message,true);}finally{busy=false;}}
  function recordLocal(kind,component){
    if(!epoch){if(issues.length<4)issues.push({kind,component});return;}
    const body={epoch,kind,component};
    if(kind==='open'&&launch)body.launch=launch;
    fetch('/api/diagnostics/browser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>{
      if(response.ok&&body.launch===launch&&launch){
        const address=new URL(location.href);
        address.searchParams.delete('launch');history.replaceState(history.state,'',address.pathname+address.search+address.hash);launch=null;
      }
    }).catch(()=>{});
  }
  function ready(id){
    epoch=id;if(started===id)return;started=id;recordLocal('open','page');issues.splice(0).forEach(e=>recordLocal(e.kind,e.component));
    if(!el('diagnostics').hidden)void open();
  }
  // 浏览器只给本机服务传固定类别，不传堆栈、消息、用户代理原文或网址。
  window.addEventListener('error',e=>{const file=(e.filename||'').split('/').pop();const component=({'app.js':'app','assist.js':'assist','diagnostics.js':'diagnostics'})[file]||'page';recordLocal('script',component);});
  window.addEventListener('unhandledrejection',()=>recordLocal('rejection','page'));
  el('diagRefresh').onclick=open;el('diagProblems').onchange=()=>{visible=30;render();};el('diagMore').onclick=()=>{visible+=50;render();};
  el('diagExport').onclick=async()=>{try{const v=await read();save('联调诊断-v'+v.version+'-'+v.exportedAt.replace(/[:.]/g,'-')+'.json',v);}catch(e){feedback(e.message,true);}};
  el('diagChoose').onclick=()=>el('diagFiles').click();
  el('diagFiles').onchange=async e=>{
    const files=Array.from(e.target.files);e.target.value='';if(!files.length)return;
    summary=null;el('diagSummary').disabled=true;el('diagGroups').hidden=true;el('diagIssues').replaceChildren();
    try{
      if(files.length>40||files.some(f=>f.size>2*1024*1024))throw Error('每次最多选择 40 份报告，每份最多 2 MB');
      const reports=[];for(const file of files)reports.push(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));
      summary=fmt.summarize(reports);
      el('diagTotals').textContent=summary.reports+' 份报告 · '+summary.installations+' 个安装 · '+summary.events+' 条事件 · 已合并 '+summary.duplicates+' 条重复事件';
      el('diagGroupRows').replaceChildren(...summary.groups.map(g=>tr(['v'+g.app+' · '+(g.os==='win32'?'Windows':g.os)+' '+g.build+' '+g.arch,route(g)||'服务',g.installs,g.events,g.problems])));
      el('diagGroups').hidden=false;el('diagSummary').disabled=false;
      if(summary.issues.length){
        const list=document.createElement('ul');for(const issue of summary.issues.slice(0,20)){const li=document.createElement('li');li.textContent=[fmt.events[issue.kind],fmt.causes[issue.cause],route(issue),issue.count+' 次，涉及 '+issue.installs+' 个安装'].filter(Boolean).join(' · ');list.append(li);}el('diagIssues').append(list);
      }
    }catch(e){el('diagTotals').textContent=e instanceof SyntaxError?'文件不是有效的诊断 JSON，请重新选择平台导出的报告。':e.message;}
  };
  el('diagSummary').onclick=()=>{if(summary)save('联调诊断汇总.json',summary);};
  window.BenchDiagnostics={open,ready};
})();
