'use strict';
// 同一份字段白名单同时用于写盘、导出和维护端导入。新项目名称、报文和原始错误不能直接进入报告。
(function (root, factory) {
  const format = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = format;
  else root.BenchReports = format;
})(globalThis, function () {
  const events = {
    'service.start':'服务启动', 'service.stop':'服务停止', 'service.launch':'启动检查', 'service.test':'一键自测',
    'project.apply':'项目配置', 'files.scan':'识别工程', 'software.detect':'检测厂家软件',
    'screen.check':'触摸屏验屏', 'input.start':'物理启动', 'input.stop':'物理停止', 'input.reset':'物理复位',
    'input.estop':'按下急停', 'input.release':'释放急停', 'hmi.start':'屏上启动', 'hmi.stop':'屏上停止', 'hmi.reset':'屏上复位',
    'plc.link':'PLC 通信', 'plc.phase':'PLC 运行阶段', 'plc.request':'PLC 命令握手', 'plc.reconcile':'核对应答',
    'mqtt.link':'设备 MQTT 连接', 'mqtt.session':'Broker 客户端异常', 'mqtt.message':'MQTT 业务回执',
    'check.tcp':'试连 TCP 端口', 'check.registers':'试读联调点表', 'check.single':'试读程序变量',
    'check.plc':'检查 PLC 读数', 'check.screen':'核对屏上读数', 'check.broker':'检查本机 Broker',
    'check.device':'核对设备编号', 'check.topic':'检查主题订阅', 'check.reply':'检查回执来源',
    'link.plc':'切换 PLC 通道', 'link.screen':'切换屏供电', 'link.mqtt':'切换 MQTT 通道',
    'browser.open':'打开网页', 'browser.error':'网页运行异常', 'api.request':'操作请求'
  };
  const levels = {info:'记录',pass:'通过',wait:'待验证',warn:'提醒',fail:'失败'};
  const causes = {none:'',refused:'连接被拒绝',timeout:'等待超时',address:'地址或数据区不符',unit:'站号不符',
    port:'端口占用',offline:'通道断开',permission:'无访问权限',storage:'文件读写失败',corrupt:'保存数据损坏',
    config:'配置或参数无效',busy:'任务或操作进行中',device:'设备编号不匹配',topic:'订阅主题不匹配',
    source:'回执来源待核对',receipt:'尚无匹配回执',rejected:'设备拒绝命令',uncertain:'执行结果待核对',disabled:'当前项目停用',
    operator:'手动通断测试',screen:'等待核对屏上读数',missing:'文件或组件未找到',unexpected:'未分类异常',
    script:'页面脚本出错',rejection:'异步操作异常',peer:'客户端协议错误',untracked:'仅验证发送',disconnected:'设备已离线'};
  const choices = {
    plc:['generic','s7200','tia','haiwell','mitsubishi','inovance'], hmi:['generic','haiwell','mcgs','weintek'],
    series:['generic','classic','smart','tia','haiwell','mitsubishi','inovance'], driver:['modbus','s7','mc3e'],
    source:['model','native'], owner:['hmi','gateway'], receiver:['builtin','external'],
    browser:['Edge','Chrome','Firefox','Safari','Other'], software:['haiwell','tia','classic','smart','mitsubishi','inovance','mcgs','weintek'],
    role:['plc','hmi'], component:['app','assist','diagnostics','page'], mode:['direct','enable'],
    action:['start','stop','reset','query','other'], channel:['http','mqtt','modbus'],
    operation:['start','status','stop','test','project','files','controls','mqtt','screen','diagnostics','other']};
  const labels = {generic:'通用',s7200:'西门子 S7-200',classic:'西门子 S7-200 经典型',smart:'西门子 S7-200 SMART',tia:'西门子博途',haiwell:'海为',mitsubishi:'三菱',inovance:'汇川',mcgs:'昆仑通态',weintek:'威纶通',modbus:'Modbus TCP',s7:'S7 TCP',mc3e:'MC 3E',hmi:'触摸屏',gateway:'网关',native:'外部运行端',model:'内置 PLC',external:'外部程序',builtin:'内置程序'};
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const version = v => typeof v==='string' && /^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(v) ? v : '';
  const owns = (list,k) => typeof k==='string' && Object.hasOwn(list,k);
  function fields(value) {
    const src = value || {}, out = {};
    for(const [key,allowed] of Object.entries(choices)) if(allowed.includes(src[key])) out[key]=src[key];
    for(const k of ['phase','plcCode','count','durationMs','browserMajor']) {
      if(Number.isInteger(src[k]) && src[k]>=0 && src[k]<=({phase:4,plcCode:255,count:10000,durationMs:600000,browserMajor:999})[k]) out[k]=src[k];
    }
    if(typeof src.running==='boolean') out.running=src.running;
    if(version(src.softwareVersion)) out.softwareVersion=src.softwareVersion;
    return out;
  }
  function cleanRun(v) {
    if(!v || !uuid.test(v.id) || !version(v.app)) return null;
    return {id:v.id,app:v.app,os:['win32','linux','darwin'].includes(v.os)?v.os:'other',
      build:version(v.build), arch:['x64','ia32','arm64','arm'].includes(v.arch)?v.arch:'other',node:version(v.node)};
  }
  function cleanEvent(v) {
    if(!v || !uuid.test(v.run) || !Number.isSafeInteger(v.seq) || v.seq<1 || !Number.isSafeInteger(v.time) || v.time<0 || v.time>8.64e15 ||
       !owns(events,v.kind) || !owns(levels,v.level)) return null;
    return {run:v.run,seq:v.seq,time:v.time,kind:v.kind,level:v.level,cause:owns(causes,v.cause)?v.cause:'none',...fields(v)};
  }
  function summarize(reports) {
    const seen=new Set(),installs=new Set(),groups=new Map(),issues=new Map();
    let duplicates=0;
    for(const report of reports) {
      if(report?.format!=='industrial-bench-diagnostics/1'||!uuid.test(report.installation)||!Array.isArray(report.runs)||!Array.isArray(report.events)||report.events.length>600||report.runs.length>600) throw Error('请选择平台导出的诊断 JSON 文件');
      const runs=new Map(report.runs.map(cleanRun).filter(Boolean).map(r=>[r.id,r]));
      installs.add(report.installation);
      for(const raw of report.events) {
        const e=cleanEvent(raw),run=e&&runs.get(e.run);
        if(!run) throw Error('报告含有无效的事件或缺少运行环境');
        const id=[report.installation,e.run,e.seq].join('/');
        if(seen.has(id)){duplicates++;continue;} seen.add(id);
        const key=[run.app,run.os,run.build,run.arch,e.plc||'',e.series||'',e.hmi||'',e.driver||'',e.source||'',e.owner||'',e.receiver||''].join('|');
        if(!groups.has(key)) groups.set(key,{app:run.app,os:run.os,build:run.build,arch:run.arch,plc:e.plc,series:e.series,hmi:e.hmi,driver:e.driver,source:e.source,owner:e.owner,receiver:e.receiver,events:0,problems:0,installs:new Set()});
        const g=groups.get(key);g.events++;g.installs.add(report.installation);
        if(e.level==='warn'||e.level==='fail'){
          g.problems++;const issueKey=[key,e.kind,e.cause].join('|');
          if(!issues.has(issueKey)) issues.set(issueKey,{app:g.app,os:g.os,build:g.build,arch:g.arch,plc:g.plc,series:g.series,hmi:g.hmi,driver:g.driver,source:g.source,owner:g.owner,receiver:g.receiver,kind:e.kind,cause:e.cause,count:0,installs:new Set()});
          const i=issues.get(issueKey);i.count++;i.installs.add(report.installation);
        }
      }
    }
    const rows=(map,k)=>[...map.values()].map(v=>({...v,installs:v.installs.size})).sort((a,b)=>b[k]-a[k]);
    return {reports:reports.length,installations:installs.size,events:seen.size,duplicates,groups:rows(groups,'events'),issues:rows(issues,'count')};
  }
  return {events,levels,causes,labels,uuid,version,fields,cleanRun,cleanEvent,summarize};
});
