'use strict';
(() => {
  const dialog=$('protocolDialog'), list=$('protocolList'), input=$('protocolFiles');
  const names={command:'下发按钮',example:'上行或回执样例',unknown:'待确认'};
  const fields=['kind','name','topic','format','qos','payload','replyTopic','requestKey','replyKey'];
  const field=k=>$('protocol'+k[0].toUpperCase()+k.slice(1));
  let rows=[],warnings=[],current=-1,epoch='',generation=0,busy=false,signature='';
  function eligible(r){
    if(!Object.hasOwn(names,r.kind)||r.kind==='unknown'||!r.name.trim()||!r.topic.trim()||!r.payload.trim())return false;
    if(r.format==='json'){try{JSON.parse(r.payload);}catch{return false;}}
    return !(r.kind==='command'&&r.replyTopic&&(!r.requestKey||!r.replyKey));
  }
  function footer(){
    const n=rows.filter(r=>r.selected).length;
    setText('protocolCount','已选 '+n+' / '+rows.length+' 条');
    $('protocolAll').checked=rows.length>0&&n===rows.length;
    $('protocolAll').indeterminate=n>0&&n<rows.length;
    $('protocolSave').disabled=busy||!n;
    $('protocolChoose').disabled=busy;
  }
  function showWarnings(){const ul=$('protocolMessages');ul.replaceChildren(...warnings.map(w=>element('li',w)));ul.hidden=!warnings.length;}
  function showEditor(){
    const row=rows[current];
    if(!row)return;
    for(const k of fields)field(k).value=row[k]??'';
    setText('protocolSource',row.file+' · '+row.where);
    setText('protocolHint',row.note||'');
    $('protocolReplyBox').hidden=row.kind!=='command';
  }
  function draw(){
    $('protocolWork').hidden=!rows.length;
    list.replaceChildren(...rows.map((r,i)=>{
      const line=element('div',undefined,'protocolRow'+(current===i?' active':''));
      const check=element('input');check.type='checkbox';check.checked=r.selected;check.setAttribute('aria-label','选择 '+r.name);
      check.onchange=()=>{r.selected=check.checked;footer();};
      const b=element('button');b.type='button';b.append(element('b',r.name||'待命名报文'),element('small',names[r.kind]+(eligible(r)?'':' · 需核对')));
      b.onclick=()=>{current=i;draw();list.children[i].querySelector('button').focus({preventScroll:true});};line.append(check,b);return line;
    }));
    showEditor();footer();showWarnings();
  }
  for(const k of fields)field(k).addEventListener('input',()=>{
    const r=rows[current];if(!r)return;
    r[k]=k==='qos'?Number(field(k).value):field(k).value;
    const line=list.children[current];line.querySelector('b').textContent=r.name||'待命名报文';
    line.querySelector('small').textContent=names[r.kind]+(eligible(r)?'':' · 需核对');
    $('protocolReplyBox').hidden=r.kind!=='command';
  });
  function reset(){
    generation++;busy=false;rows=[];warnings=[];current=-1;input.value='';draw();setText('protocolStatus','');
  }
  function close(){if(!busy||confirm('文件还在读取，确定关闭导入窗口？'))dialog.close();}
  dialog.addEventListener('close',reset);
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  $('protocolClose').onclick=close;
  $('protocolOpen').onclick=()=>{if(!s)return;epoch=s.epoch;reset();dialog.showModal();};
  $('protocolChoose').onclick=()=>input.click();
  $('protocolAll').onchange=e=>{for(const r of rows)r.selected=e.target.checked;draw();};
  async function files(selected){
    if(busy||!selected.length)return;
    if(selected.length>8){warnings=['每次最多选择 8 个文件，请分批导入。'];showWarnings();return;}
    const token=generation,capturedEpoch=epoch;busy=true;warnings=[];draw();
    try{
      for(const file of selected){
        if(token!==generation)return;
        setText('protocolStatus','正在读取 '+file.name+'…');
        try{
          if(!file.size||file.size>8*1024*1024)throw Error('请选择有内容且不超过 8 MB 的文件');
          const ext=file.name.split('.').at(-1).toLowerCase();
          const response=await fetch('/api/protocol/analyse?type='+encodeURIComponent(ext),{
            method:'POST',headers:{'Content-Type':'application/octet-stream','X-Bench-Epoch':capturedEpoch},body:file});
          const data=await response.json();if(!response.ok)throw Error(data.error||'文档读取失败');
          if(token!==generation)return;
          if(rows.length+data.candidates.length>96)throw Error('预览上限为 96 条，请先保存当前批次');
          for(const item of data.candidates)rows.push({...item,file:file.name,selected:eligible(item)});
          for(const message of data.warnings)warnings.push(file.name+' · '+message);
        }catch(e){if(token===generation)warnings.push(file.name+' · '+e.message);}
      }
      if(token===generation){
        if(current<0&&rows.length)current=0;
        setText('protocolStatus',rows.length?'已识别 '+rows.length+' 条，请核对方向和内容':'未识别到可导入报文');
      }
    }finally{if(token===generation){busy=false;draw();}}
  }
  input.onchange=()=>{const picked=[...input.files];input.value='';void files(picked);};
  const drop=$('protocolDrop');
  drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};drop.ondragleave=()=>drop.classList.remove('over');
  drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');void files([...e.dataTransfer.files]);};
  $('protocolTemplate').onclick=()=>{
    const lines=[['名称','方向','主题','QoS','报文','回执主题','指令关联字段','回执关联字段'],
      ['查询状态','平台→设备','{{prefix}}command','1',JSON.stringify({deviceId:'{{device}}',seq:'{{seq}}',timestamp:'{{timestamp}}',action:'query',params:{}}),'{{prefix}}reply','seq','seq'],
      ['查询回执','设备→平台','{{prefix}}reply','1',JSON.stringify({seq:'示例编号',success:true,msg:'已读取'}),'','','']];
    const csv=lines.map(row=>row.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
    const link=element('a');link.href=url;link.download='MQTT协议示例表.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  };
  $('protocolSave').onclick=async()=>{
    if(busy)return;
    const selected=rows.filter(r=>r.selected);
    const bad=selected.find(r=>!eligible(r));
    if(bad){current=rows.indexOf(bad);warnings=['请补全当前报文，或取消勾选后保存其他条目。'];draw();return;}
    if(!selected.length||epoch!==s?.epoch)return;
    const token=generation;busy=true;footer();
    try{
      const items=selected.map(r=>Object.fromEntries(fields.map(k=>[k,r[k]])));
      const res=await post('/api/protocol/import',{items});
      if(token!==generation)return;
      dialog.close();await refresh(true);
      notice('已保存 '+res.added+' 个按钮、'+res.samples+' 条样例，跳过 '+res.skipped+' 条重复报文。');
    }catch(e){if(token===generation){warnings=[e.message];showWarnings();}}
    finally{if(token===generation){busy=false;footer();}}
  };
  function project(state){
    if(dialog.open && epoch!==state.epoch){dialog.close();notice('当前项目已切换，请重新导入文件。',true);}
    const samples=state.project.messageExamples||[], next=state.epoch+JSON.stringify(samples);
    if(next===signature)return;signature=next;
    $('protocolSamples').hidden=!samples.length;
    $('sampleList').replaceChildren(...samples.map(x=>{
      const row=element('div',undefined,'protocolSample'),view=element('button',x.name,'buttonRow'),remove=element('button','删除','dangerText');
      view.type=remove.type='button';
      view.onclick=()=>act('viewSample',async()=>{
        const r=await fetch('/api/protocol/example?id='+encodeURIComponent(x.id));const m=await r.json();if(!r.ok)throw Error(m.error);
        setText('dialogTitle',m.name);setText('dialogMeta','协议样例 · '+m.topic+' · QoS '+m.qos);setText('dialogBody',m.payload);$('detail').showModal();
      });
      remove.setAttribute('aria-label','删除样例 '+x.name);remove.onclick=()=>act('deleteSample',async()=>{
        if(!confirm('从当前项目删除样例「'+x.name+'」？'))return;await post('/api/protocol/delete-example',{id:x.id});await refresh();
      });row.append(view,remove);return row;
    }));
  }
  window.BenchImporter={project};if(typeof s!=='undefined'&&s)project(s);
})();
