import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectDir, loadProject } from './projects.js';
import { readJson, writeJson, nowIso, apiError, sha256File } from './util.js';
import { patchSource } from './studio.js';
import { resolveModel, chat } from './llm.js';
import { nextVersionLabel, finalizeVersion, discardUncommitted } from './generate.js';
import { withProjectLock } from './workflow.js';
import { buildIndex } from './index-builder.js';
export async function currentVersion(id) {
  const {meta,state}=await loadProject(id);
  if(!meta.version || !state.current) throw apiError('INVALID_OPERATION','尚无可编辑版本，请先生成或导入');
  const file=path.join(projectDir(id),state.current);
  if(!fs.existsSync(file)) throw apiError('SOURCE_NOT_FOUND','当前版本缺失');
  if(await sha256File(file)!==state.current_sha256) throw apiError('SOURCE_HASH_MISMATCH','当前版本原件发生变化，请重新导入');
  return {label:meta.version,file:path.basename(file),path:file,sha256:state.current_sha256,stage:meta.stage};
}
export async function pageShapes(id,page) {
  const cur=await currentVersion(id),insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
  const n=Number(page),slide=insp?.slides?.[n-1];
  if(!Number.isInteger(n)||!slide) throw apiError('INVALID_OPERATION','页码越界：'+page);
  return {version:cur.label,sha256:cur.sha256,page:n,slide_count:insp.slides.length,slide_size:insp.slide_size,
    shapes:slide.elements.map((e)=>({...e,shape_id:String(e.shape_id)}))};
}
function assertBase(cur,opts) {
  if((opts.version && opts.version!==cur.label)||(opts.expected_sha256 && opts.expected_sha256!==cur.sha256)) throw apiError('SOURCE_HASH_MISMATCH','基准版本已变化，请重新加载画布');
}
export async function reviseFromInstruction(id,text,modelId,opts={}) {
  const cur=await currentVersion(id); assertBase(cur,opts);
  const insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
  const explicit=String(text).match(/第\s*(\d+)\s*页/);
  if(explicit && (!insp?.slides?.[Number(explicit[1])-1])) throw apiError('INVALID_OPERATION','指令页码超出当前 PPT');
  const model=await resolveModel(modelId || (await loadProject(id)).meta.dialogue_model);
  if(!model.online) throw apiError('LLM_UNAVAILABLE','修订模型不可用：'+model.reason);
  const raw=await chat({model,json:true,timeoutMs:600000,system:'你是 PPT 修订助手。仅输出 JSON {"changes":[{"slide":1,"shape_id":"1","text":"新文字"}],"reply":"修改说明"}。中文页码转换为数字。只能修改下列真实可编辑文字形状；保留用户事实，不截断文字，空文字表示清除。未匹配时 changes=[] 并解释原因。形状：'+JSON.stringify(insp.slides.map((s)=>({page:s.number,shapes:s.elements.filter((e)=>e.editable_text)}))),messages:[{role:'user',content:text}]});
  let parsed; try{parsed=JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '');}catch{throw apiError('LLM_BAD_OUTPUT','修订模型输出不是合法 JSON');}
  if(!Array.isArray(parsed.changes)) throw apiError('LLM_BAD_OUTPUT','修订模型缺少 changes');
  if(!parsed.changes.length) return {applied:false,reply:parsed.reply || '请明确需要修改的页和内容',via:'llm',model:{id:model.id,tag:model.tag}};
  const operations=parsed.changes.map((c)=>({op:'set-text',slide:Number(c.slide),shape_id:String(c.shape_id),text:c.text}));
  const result=await applyPatch(id,operations,{version:cur.label,expected_sha256:cur.sha256,source:'dialogue',note:parsed.reply||text});
  return {...result,applied:true,reply:parsed.reply,via:'llm',model:{id:model.id,tag:model.tag}};
}
export async function applyPatch(id,operations,opts={}) {
  return withProjectLock(id,async()=>{
    const cur=await currentVersion(id); assertBase(cur,opts);
    if(!Array.isArray(operations)||!operations.length||operations.length>1000) throw apiError('INVALID_OPERATION','需要 1–1000 项操作');
    const insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
    const index=await buildIndex();
    const allowed=['set-text','replace-text','geometry','table-cell','delete-shape','insert-text','insert-image'];
    const ops=[];
    for(const original of operations) {
      const op={...original};
      const slide=insp.slides[op.slide-1];
      if(!Number.isInteger(op.slide)||!slide||!allowed.includes(op.op)) throw apiError('INVALID_OPERATION','操作页码或类型无效');
      if(!op.op.startsWith('insert-')) {
        const shape=slide.elements.find((e)=>String(e.shape_id)===String(op.shape_id));
        if(!shape) throw apiError('INVALID_OPERATION','形状不存在：'+op.shape_id);
        if(['set-text','replace-text'].includes(op.op)&&!shape.editable_text) throw apiError('UNSUPPORTED_OBJECT','对象没有可见的原生文字');
        if(op.op==='geometry'&&!shape.position) throw apiError('UNSUPPORTED_OBJECT','对象没有几何位置');
        if(op.op==='table-cell'&&(shape.kind!=='table'||!shape.cells?.[op.row]?.[op.column])) {
          if(shape.kind!=='table'||!Number.isInteger(op.row)||!Number.isInteger(op.column)||op.row<0||op.column<0||op.row>=shape.cells.length||op.column>=shape.cells[op.row].length) throw apiError('INVALID_OPERATION','表格单元格越界');
        }
      }
      if(['set-text','insert-text','table-cell'].includes(op.op)&&typeof op.text!=='string') throw apiError('INVALID_OPERATION','text 必须为字符串，允许空字符串清除');
      if(op.op==='replace-text'&&(typeof op.old!=='string'||!op.old||typeof op.new!=='string')) throw apiError('INVALID_OPERATION','替换需要非空 old 和字符串 new');
      for(const key of ['x','y','width','height','rotation']) if(op[key]!=null && (!Number.isFinite(op[key])||(['width','height'].includes(key)&&op[key]<=0))) throw apiError('INVALID_OPERATION','几何参数无效：'+key);
      if(op.op==='insert-image') {
        const asset=index.assets.find((a)=>a.id===op.asset_id);
        if(!asset) throw apiError('SOURCE_NOT_FOUND','素材不存在：'+op.asset_id);
        op.asset_path=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','assets','previews',asset.file);
        if(!fs.existsSync(op.asset_path)) throw apiError('SOURCE_NOT_FOUND','素材文件缺失');
      }
      ops.push(op);
    }
    const patchPath=path.join(projectDir(id),'patch-'+(await import('node:crypto')).randomUUID()+'.json');
    await writeJson(patchPath,{expected_sha256:cur.sha256,operations:ops,meta:{source:opts.source||'canvas',note:opts.note||'',created_at:nowIso()}});
    const ver=await nextVersionLabel(id),out=path.join(projectDir(id),'versions',ver.file);
    try {
      await patchSource(cur.path,patchPath,out);
      const result=await finalizeVersion(id,out,{phase:'sample',label:ver.label,file:ver.file,expectedSlides:insp.slides.length});
      return {...result,applied:true,source:opts.source||'canvas',note:opts.note||''};
    } catch(e) { await discardUncommitted(id,out); throw e; }
    finally { await fsp.rm(patchPath,{force:true}); }
  });
}
export async function rollbackVersion(id,label,opts={}) {
  return withProjectLock(id,async()=>{
    const cur=await currentVersion(id); assertBase(cur,opts);
    if(!/^v\d{4,}$/.test(label||'') || label===cur.label) throw apiError('INVALID_OPERATION','请选择有效的其他版本');
    const src=path.join(projectDir(id),'versions','revision-'+String(Number(label.slice(1))).padStart(3,'0')+'.pptx');
    if(!fs.existsSync(src)) throw apiError('SOURCE_NOT_FOUND','回滚版本不存在');
    const ver=await nextVersionLabel(id),out=path.join(projectDir(id),'versions',ver.file);
    await fsp.copyFile(src,out,fs.constants.COPYFILE_EXCL);
    try { return {...await finalizeVersion(id,out,{phase:'sample',label:ver.label,file:ver.file}),rolled_back_to:label}; }
    catch(e){await discardUncommitted(id,out);throw e;}
  });
}
