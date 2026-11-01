'use strict';
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const svgNS = 'http://www.w3.org/2000/svg';
const requestedPage=Number(new URLSearchParams(location.search).get('slide'));
let data, page = Number.isInteger(requestedPage)&&requestedPage>0?requestedPage:1, selected = null, mode = 'select', region = null, drag = null;
let pending = new Map(), history = [], busy = false;
const url = path => path + '?token=' + encodeURIComponent(token);
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function api(path, payload) {
  const response = await fetch(path, {headers: {'X-Studio-Token': token, ...(payload ? {'Content-Type': 'application/json'} : {})}, ...(payload ? {method: 'POST', body: JSON.stringify(payload)} : {})});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}
function setBusy(value) {
  busy = value; document.body.classList.toggle('busy', value);
  for (const id of ['apply','render','reload','saveComment','stageText','stageCell']) $(id).disabled = value;
  if (!value) updateControls();
}
function currentSlide() { return data.inspection.slides[page - 1]; }
function currentShape() { return currentSlide().elements.find(e => e.shape_id === selected); }
function edits(shape) { return pending.get(page + ':' + shape.shape_id) || []; }
function position(shape) { return {...shape.position, ...edits(shape).find(op => op.op === 'geometry')}; }
function displayedText(shape) { return edits(shape).find(op => op.op === 'set-text')?.text ?? shape.text; }
function checkpoint() { history.push(JSON.stringify([...pending])); if (history.length > 80) history.shift(); }
function stage(operation, snapshot = true) {
  if (snapshot) checkpoint();
  const key = page + ':' + operation.shape_id, list = pending.get(key) || [];
  const equal = op => op.op === operation.op && (op.op !== 'table-cell' || op.row === operation.row && op.column === operation.column);
  pending.set(key, [...list.filter(op => !equal(op)), {...operation, slide: page}]);
  updateControls();
}
function updateControls() {
  const total = [...pending.values()].flat().length;
  $('apply').disabled = busy || total === 0;
  $('apply').textContent = total ? `应用 ${total} 项修改` : '应用修改';
  $('undo').disabled = busy || history.length === 0;
  const shape = data && currentShape();
  $('stageText').disabled = busy || !shape?.editable_text;
  $('stageCell').disabled = busy || shape?.kind !== 'table' || shape?.grouped;
  $('geometryFields').disabled = busy || !shape?.editable_geometry;
}
async function load() {
  data = await api('/api/state');
  page = Math.min(page, data.inspection.slides.length);
  $('version').textContent = `版本 ${data.state.revision} · ${data.inspection.slides.length} 页 · ${data.engine === 'wps' ? 'WPS' : 'PowerPoint'} 预览`;
  $('download').href = url('/api/file');
  const pages = $('pages'); pages.replaceChildren();
  for (const slide of data.inspection.slides) {
    const button = document.createElement('button'); button.className = 'page'; button.dataset.page = slide.number;
    if (data.preview_available) { const image = document.createElement('img'); image.src = url(`/preview/${slide.number}.png`); image.alt = `第 ${slide.number} 页`; image.loading = 'lazy'; button.append(image); }
    const label = document.createElement('span'); label.textContent = `第 ${slide.number} 页`; button.append(label);
    button.onclick = () => { page = slide.number; selected = null; region = null; drawPage(); };
    pages.append(button);
  }
  const {width, height} = data.inspection.slide_size;
  $('canvas').style.aspectRatio = `${width} / ${height}`;
  $('scene').setAttribute('viewBox', `0 0 ${width} ${height}`);
  drawPage();
  status(data.state.file_changed_externally ? '文件在外部修改过，请重新渲染后核对。' : '文件已载入。');
}
function svg(name, attrs = {}) {
  const el = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}
function drawPage() {
  for (const button of $('pages').children) button.classList.toggle('active', Number(button.dataset.page) === page);
  $('preview').hidden = !data.preview_available;
  if (data.preview_available) $('preview').src = url(`/preview/${page}.png`) + '&rev=' + data.inspection.sha256;
    $('previewHint').textContent = data.preview_available ? '背景来自当前 PPT 的实际渲染。移动时边框显示待应用位置，点击应用后刷新页面图像。' : '实际渲染尚未生成。可查看对象边界，请点击“渲染当前文件”后核对页面效果。';
    if(currentSlide().elements.some(e=>e.occluded_by_full_page_picture && e.text)) $('previewHint').textContent += ' 此页含整页图片覆盖的文字，已锁定下方对象；图片中的文字需重建后才能编辑。';
  $('layers').replaceChildren();
  for (const shape of currentSlide().elements) {
    const button = document.createElement('button'); button.className = 'layer'; button.dataset.id = shape.shape_id;
    const label = shape.text.trim().split('\n')[0] || shape.name || shape.kind;
    button.textContent = `${shape.shape_id} · ${label}${shape.occluded_by_full_page_picture ? '（图片覆盖）' : shape.grouped || shape.rotated_or_flipped ? '（特殊结构）' : shape.full_page_picture ? '（整页图片）' : ''}`;
    button.title = button.textContent; button.onclick = () => select(shape.shape_id); $('layers').append(button);
  }
  drawScene(); fillProperties(); drawComments();
}
function select(id) { selected = id; drawScene(); fillProperties(); if(innerWidth>800)document.querySelector('.properties').scrollTop=0; }
function drawScene() {
  const scene = $('scene'); scene.replaceChildren();
  const defs = svg('defs'), marker = svg('marker', {id:'arrowhead',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});
  marker.append(svg('path', {d:'M 0 0 L 10 5 L 0 10 z',fill:'#b45309'})); defs.append(marker); scene.append(defs);
  for (const shape of currentSlide().elements) {
    if (!shape.position || shape.grouped || shape.hidden || shape.occluded_by_full_page_picture) continue;
    const p = position(shape);
    const rect = svg('rect', {x:p.x,y:p.y,width:p.width,height:p.height,'data-id':shape.shape_id,tabindex:0,role:'button','aria-label':shape.name || shape.text.slice(0,60) || shape.kind, class:'element' + (shape.shape_id === selected ? ' selected' : '') + (!shape.editable_geometry ? ' locked' : '')});
    rect.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(shape.shape_id); }
      else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && shape.editable_geometry && !busy) {
        event.preventDefault(); selected = shape.shape_id;
        const step = event.shiftKey ? 10 : 1, p = position(shape);
        p.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        p.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        stage({op:'geometry',shape_id:shape.shape_id,x:p.x,y:p.y,width:p.width,height:p.height}); drawScene(); fillProperties();
        $('scene').querySelector(`[data-id="${CSS.escape(shape.shape_id)}"]`)?.focus();
      }
    });
    scene.append(rect);
    if (shape.shape_id === selected && shape.editable_geometry && mode === 'select') {
      scene.append(svg('rect', {x:p.x+p.width-7,y:p.y+p.height-7,width:14,height:14,'data-id':shape.shape_id,'data-resize':'true',class:'handle'}));
      const label = svg('text', {x:p.x+4,y:Math.max(16,p.y-7)}); label.textContent = `${shape.name || shape.kind} · ${shape.shape_id}`; scene.append(label);
    }
  }
  const regions = data.annotations.filter(a => a.slide === page && a.source_sha256 === data.inspection.sha256 && a.region).map(a=>a.region);
  if (region) regions.push(region);
  for (const r of regions) {
    if (r.kind === 'arrow') scene.append(svg('line',{x1:r.x1,y1:r.y1,x2:r.x2,y2:r.y2,class:'arrow','marker-end':'url(#arrowhead)'}));
    else scene.append(svg('rect',{x:Math.min(r.x1,r.x2),y:Math.min(r.y1,r.y2),width:Math.abs(r.x2-r.x1),height:Math.abs(r.y2-r.y1),class:'region'}));
  }
}
function fillProperties() {
  const shape = currentShape();
  $('selectionHint').textContent = shape ? `${shape.name || shape.kind} · ID ${shape.shape_id}${shape.occluded_by_full_page_picture ? '，被整页图片覆盖，修改下方文字不会改变实际显示。' : shape.full_page_picture ? '，整页图片中的文字不能直接修改。' : shape.grouped ? '，组合对象需通过 Codex 或原生软件修改。' : shape.rotated_or_flipped ? '，旋转或翻转对象的位置已锁定。' : ''}` : '选择页面元素，或从图层列表选择。';
  for (const button of $('layers').children) button.classList.toggle('active', button.dataset.id === selected);
  for (const key of ['x','y','width','height']) $(key).value = shape?.position ? Math.round(position(shape)[key] * 10) / 10 : '';
  $('elementText').disabled = !shape?.editable_text;
  $('elementText').value = shape ? displayedText(shape) : '';
  $('tablePanel').hidden = shape?.kind !== 'table';
  if (shape?.kind === 'table') fillCell();
  updateControls();
}
function fillCell() {
  const shape = currentShape(); if (shape?.kind !== 'table') return;
  const row = Number($('cellRow').value)-1, column = Number($('cellColumn').value)-1;
  $('cellText').value = edits(shape).find(op=>op.op==='table-cell' && op.row===row && op.column===column)?.text ?? shape.cells[row]?.[column] ?? '';
}
function drawComments() {
  $('annotations').replaceChildren();
  for (const item of data.annotations.filter(a=>a.slide===page)) {
    const div = document.createElement('div'); div.className = 'annotation';
    div.textContent = `版本 ${item.revision} · ${item.status === 'pending' ? '待处理' : item.status}\n${item.comment}`;
    $('annotations').append(div);
  }
}
function point(event) {
  const matrix = $('scene').getScreenCTM();
  if (!matrix) return {x:0,y:0};
  const p = new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
  return {x:p.x,y:p.y};
}
$('scene').addEventListener('pointerdown', event => {
  if (busy || event.button !== 0) return;
  event.preventDefault(); const p = point(event);
  if (mode !== 'select') { region = {kind:mode,x1:p.x,y1:p.y,x2:p.x,y2:p.y}; drag={kind:'region'}; }
  else {
    const id = event.target.getAttribute('data-id'); if (!id) { selected=null; fillProperties(); drawScene(); return; }
    selected=id; const shape=currentShape();
    if (!shape.editable_geometry) { fillProperties(); drawScene(); return; }
    checkpoint(); drag={kind:event.target.hasAttribute('data-resize') ? 'resize' : 'move',start:p,original:position(shape),shape_id:id};
  }
  $('scene').setPointerCapture(event.pointerId); drawScene(); fillProperties();
});
$('scene').addEventListener('pointermove', event => {
  if (!drag) return; const p=point(event);
  if (drag.kind==='region') { region.x2=p.x; region.y2=p.y; }
  else {
    const d=drag, g={...d.original}, dx=p.x-d.start.x,dy=p.y-d.start.y;
    if (d.kind==='move') { g.x+=dx;g.y+=dy; } else { g.width=Math.max(8,g.width+dx);g.height=Math.max(8,g.height+dy); }
    stage({op:'geometry',shape_id:d.shape_id,x:g.x,y:g.y,width:g.width,height:g.height},false);
  }
  drawScene(); fillProperties();
});
function endDrag(){drag=null;updateControls();}
$('scene').addEventListener('pointerup',endDrag); $('scene').addEventListener('pointercancel',endDrag);
for (const [id,value] of [['selectMode','select'],['boxMode','box'],['arrowMode','arrow']]) $(id).onclick=()=>{
  mode=value; for(const [other,otherValue] of [['selectMode','select'],['boxMode','box'],['arrowMode','arrow']]) $(other).setAttribute('aria-pressed',String(value===otherValue));drawScene();
};
$('geometryForm').onsubmit=event=>{
  event.preventDefault(); const shape=currentShape(); if(!shape?.editable_geometry)return;
  const g=Object.fromEntries(['x','y','width','height'].map(k=>[k,Number($(k).value)]));
  if(!Object.values(g).every(Number.isFinite)||g.width<=0||g.height<=0){status('请输入有效的位置和正数尺寸。',true);return;}
  stage({op:'geometry',shape_id:selected,...g});drawScene();status('位置与尺寸已暂存。');
};
$('stageText').onclick=()=>{if(!currentShape()?.editable_text)return;stage({op:'set-text',shape_id:selected,text:$('elementText').value});status('文字修改已暂存，点击应用后查看实际效果。');};
$('cellRow').onchange=fillCell;$('cellColumn').onchange=fillCell;
$('stageCell').onclick=()=>{
  const shape=currentShape(),row=Number($('cellRow').value)-1,column=Number($('cellColumn').value)-1;
  if(!shape?.cells[row]||column<0||column>=shape.cells[row].length){status('单元格超出表格范围。',true);return;}
  stage({op:'table-cell',shape_id:selected,row,column,text:$('cellText').value});status('单元格修改已暂存。');
};
$('undo').onclick=()=>{if(!history.length)return;pending=new Map(JSON.parse(history.pop()));drawScene();fillProperties();status('已撤销上一项待应用操作。');};
$('reload').onclick=async()=>{
  if(pending.size&&!confirm('重新载入会清除待应用修改，是否继续？'))return;
  pending.clear();history=[];selected=null;region=null;
  try{await load();}catch(e){status(e.message,true);}
};
$('apply').onclick=async()=>{
  setBusy(true);status('正在写入新版本并渲染，请稍候。');
  try{
    const result=await api('/api/apply',{expected_sha256:data.inspection.sha256,operations:[...pending.values()].flat()});
    pending.clear();history=[];region=null;await load();
    status(result.render_error?`文件已保存；实际预览尚未验证：${result.render_error}`:'新版本已保存并渲染，请核对页面效果。',!!result.render_error);
  }catch(e){status(e.message,true);}finally{setBusy(false);}
};
$('render').onclick=async()=>{
  setBusy(true);status('正在使用原生软件渲染当前文件。');
  try{await api('/api/render',{});await load();status('实际预览已更新，视觉与编辑性检查仍需核对。');}catch(e){status(e.message,true);}finally{setBusy(false);}
};
$('saveComment').onclick=async()=>{
  try{
    await api('/api/annotations',{expected_sha256:data.inspection.sha256,slide:page,shape_id:selected,region,comment:$('comment').value});
    $('comment').value='';region=null;data.annotations=(await api('/api/state')).annotations;drawScene();drawComments();status('批注已保存。回到 Codex 说明“按画布批注修改”。');
  }catch(e){status(e.message,true);}
};
window.addEventListener('beforeunload',event=>{if(pending.size){event.preventDefault();event.returnValue='';}});
load().catch(e=>status(e.message,true));
