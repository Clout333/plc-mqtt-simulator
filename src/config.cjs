'use strict';
const fs=require('node:fs'),path=require('node:path');
function validate(c){
  const fail=m=>{throw Error('配置错误：'+m);};
  if(c.schemaVersion!==1)fail('schemaVersion应为1');
  if(c.bind!=='127.0.0.1')fail('本模板只绑定127.0.0.1；局域网接入需单独适配');
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(c.projectId))fail('projectId格式不正确');
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(c.deviceId))fail('deviceId格式不正确');
  if(!['hmi','plc','gateway'].includes(c.topology))fail('topology只取hmi/plc/gateway');
  if(!['model','external'].includes(c.deviceImplementation))fail('处理器只取model/external');
  const ports=Object.values(c.ports||{});
  if(ports.length!==3||new Set(ports).size!==3||ports.some(x=>!Number.isInteger(x)||x<1024||x>65535))fail('三个端口应不同且为1024～65535整数');
  if(!Number.isInteger(c.unitId)||c.unitId<1||c.unitId>247)fail('站号范围1～247');
  if(typeof c.topicPrefix!=='string'||!c.topicPrefix.endsWith('/')||c.topicPrefix.length>128||/[+#\s\0]/.test(c.topicPrefix))fail('主题前缀末尾须为/，不能含通配符或空白');
  for(const key of ['heartbeatSeconds','maxCommandAgeSeconds','futureToleranceSeconds'])if(!Number.isFinite(c[key])||c[key]<1||c[key]>3600)fail(key+'范围1～3600');
  for(const key of ['prepareSeconds','finishSeconds'])if(!Number.isFinite(c[key])||c[key]<0||c[key]>3600)fail(key+'范围0～3600');
  for(const key of ['historyLimit','recipeLimit'])if(!Number.isInteger(c[key])||c[key]<1||c[key]>1000)fail(key+'范围1～1000');
  for(const key of ['coilBase','holdingBase'])if(!Number.isInteger(c.modbus?.[key])||c.modbus[key]<0||c.modbus[key]>65000)fail('Modbus基址不合法');
  return c;
}
function load(root){return validate(JSON.parse(fs.readFileSync(path.join(root,'project.json'),'utf8').replace(/^\uFEFF/,'')));}
module.exports={load,validate};
