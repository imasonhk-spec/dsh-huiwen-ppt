import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectDir, loadProject } from './projects.js';
import { readJson, writeJson, nowIso, apiError, sha256File } from './util.js';
import { patchSource } from './studio.js';
import { resolveModel, chatJson } from './llm.js';
import { nextVersionLabel, finalizeVersion, discardUncommitted } from './generate.js';
import { withProjectLock, withPptOperation } from './workflow.js';
import { loadBrief } from './brief.js';
import { readJsonl, stableHash } from './util.js';
import { reviewDraft, groundedText, originalMaterials, reviewChecklist } from './quality.js';
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
export function revisionIssue(value,slides) {
  if(!Array.isArray(value.changes)||value.changes.length>1000) return 'changes必须为0–1000项数组';
  const seen=new Set();
  for(const c of value.changes) {
    if(!c||!Number.isInteger(c.slide)||typeof c.shape_id!=='string'||typeof c.text!=='string') return 'slide须为整数，shape_id及text须为字符串';
    const key=c.slide+':'+c.shape_id;
    if(seen.has(key)) return '重复形状 '+key;
    seen.add(key);
    if(!slides.find(s=>s.number===c.slide)?.elements.some(e=>String(e.shape_id)===c.shape_id&&e.editable_text)) return '不可编辑或不存在的页/形状 '+key+'；第'+c.slide+'页可编辑shape_id仅为 '+JSON.stringify((slides.find(s=>s.number===c.slide)?.elements||[]).filter(e=>e.editable_text).map(e=>String(e.shape_id)))+'；编号只在本页有效，不得借用其他页；不要猜测或自动替换';
  }
}
export function revisionTargets(slides) {
  return slides.flatMap(s=>s.elements.filter(e=>e.editable_text).map(e=>({target:'p'+s.number+':s'+String(e.shape_id),slide:s.number,shape_id:String(e.shape_id),name:e.name,text:e.text||''})));
}
export function compileRevisionTargets(value,targets) {
  if(!Array.isArray(value.changes)||value.changes.length>1000) throw apiError('LLM_BAD_OUTPUT','changes必须为0–1000项数组');
  const seen=new Set();
  const changes=value.changes.map(c=>{
    const target=targets.find(t=>t.target===c?.target);
    if(!target||typeof c.text!=='string'||seen.has(c.target)||c.slide!==undefined||c.shape_id!==undefined) throw apiError('LLM_BAD_OUTPUT','target必须逐字选唯一合法token，不接受独立猜测页/形状：'+String(c?.target)+'；合法token：'+JSON.stringify(targets.map(t=>t.target)));
    seen.add(c.target);return {slide:target.slide,shape_id:target.shape_id,text:c.text};
  }).filter(c=>c.text!==targets.find(t=>t.slide===c.slide&&t.shape_id===c.shape_id).text);
  if(value.changes.length&&!changes.length) throw apiError('LLM_BAD_OUTPUT','修改未落实：changes没有实际改动，不能声称已修改');
  return changes;
}
export function revisionCandidateBase(targets,originalVersion) {
  if(!originalVersion||typeof originalVersion.version!=='string'||!originalVersion.version||! /^[a-f0-9]{64}$/.test(originalVersion.sha256||'')) throw apiError('SOURCE_HASH_MISMATCH','修订缺少原文件version/sha256绑定');
  const {version,sha256}=originalVersion;
  return {version,sha256,candidate_sha256:stableHash({version,sha256,targets:targets.map(({target,text})=>({target,text}))})};
}
export function amendRevisionTargets(targets,changes) {
  const execution=compileRevisionTargets({changes},targets);
  return targets.map(t=>({...t,text:execution.find(c=>c.slide===t.slide&&c.shape_id===t.shape_id)?.text??t.text}));
}
export function revisionPlanIssue(value,targets,checklist) {
  if(!Array.isArray(value.requirement_map)||value.requirement_map.length!==checklist.length) return 'requirement_map须覆盖完整sourceChecklist';
  const executionChanges=compileRevisionTargets(value,targets);
  const changed=new Set(executionChanges.map(c=>targets.find(t=>t.slide===c.slide&&t.shape_id===c.shape_id).target));
  const seen=new Set(),mapped=new Set();
  for(const item of value.requirement_map) {
    const unit=checklist.find(u=>u.id===item?.id);
    if(!unit||seen.has(item.id)||!['change','keep','internal','superseded'].includes(item.action)||!Array.isArray(item.targets)||new Set(item.targets).size!==item.targets.length||typeof item.reason!=='string'||!item.reason.trim()) return 'requirement_map的id/action/targets/reason无效或重复';
    seen.add(item.id);
    if(item.targets.some(id=>!targets.some(t=>t.target===id))) return 'requirement_map只能引用真实target';
    if(item.action==='change'&&!item.targets.length) return 'change须指定实际目标：'+item.id;
    if(item.action==='keep'&&!item.targets.length&&item.scope!=='whole_deck') return '全稿否定边界keep须显式scope=whole_deck：'+item.id;
    if(item.action==='change') {
      const actual=item.targets.filter(target=>changed.has(target));
      if(!actual.length) return item.id+'的change组没有实际差分：'+item.targets.join('、');
      for(const target of actual) mapped.add(target);
    }
    if(item.action==='superseded') {const newer=checklist.find(u=>u.id===item.superseded_by);if(!newer||newer.user_order==null||newer.user_order<=(unit.user_order??-1)) return '撤销须引用较新用户要求';}
  }
  if([...changed].some(target=>!mapped.has(target))) return '每个change必须映射到有效源要求';
}
export function revisionSchema(base,targets,checklist) {
  const ids=checklist.map(u=>u.id),targetIds=targets.map(t=>t.target),idSchema=ids.length?{type:'string',enum:ids}:{type:'string'};
  const object=(properties)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
  return object({mode:{const:'amend'},base:object(Object.fromEntries(Object.entries(base).map(([key,value])=>[key,{const:value}]))),
    changes:{type:'array',maxItems:1000,items:object({target:{type:'string',enum:targetIds},text:{type:'string'}})},reply:{type:'string'},
    requirement_map:{type:'array',minItems:ids.length,maxItems:ids.length,items:object({id:idSchema,action:{type:'string',enum:['change','keep','internal','superseded']},targets:{type:'array',items:{type:'string',enum:targetIds}},reason:{type:'string'},scope:{enum:['whole_deck',null]},superseded_by:{anyOf:[idSchema,{type:'null'}]}})}});
}
export async function draftRevision(model,targets,sourceChecklist,feedback='',originalVersion) {
  if(!targets.length) throw apiError('INVALID_OPERATION','没有可编辑文字目标');
  const base=revisionCandidateBase(targets,originalVersion);
  const pages=[...new Set(targets.map(t=>t.slide))].map(page=>({page,targets:targets.filter(t=>t.slide===page).map(({target,name,text})=>({target,name,text}))}));
  const proposal=await chatJson({model,schema:revisionSchema(base,targets,sourceChecklist),timeoutMs:600000,maxTokens:Math.max(4096,sourceChecklist.length*128),system:[
    '你是PPT修订作者。user数据中sourceChecklist是完整原文，pages是全部页面的可编辑对象。先逐页对照全部有效要求，返回绑定当前base的增量补丁。mode必须amend，不支持相对原稿的完整替换；未列对象保留当前候选文字。',
    '事实边界：保留未撤销的业务要求。user_order表示用户先后；origins表示材料/成员身份，材料不能撤销用户要求。历史删除持续有效，除非较新用户明确撤销；删除包含同义表述，必须真的删除，不能加“按制度确认”等限定后保留。无来源的制度、已完成测试/成果不能冒充事实，应删除或改为有依据的一般操作。相对顺序不等于固定时长，按原要求处理。不新增事实。',
    '对象边界：每个target只能从pages逐字复制完整token，必须核对同一条目的当前text；禁止跨页拼接编号、猜测不存在target或输出独立slide/shape_id。一对象一次，text允许空串清除；只需提交实际改动，混合要求组可附已满足的原文条目但它们不会执行，不能把它们单独声称为修改。未列对象自动保留。',
    '只返回JSON {"mode":"amend","base":{"version":"逐字回传","sha256":"逐字回传","candidate_sha256":"逐字回传"},"changes":[{"target":"从pages复制的token","text":"新文字"}],"reply":"简洁说明","requirement_map":[]}。requirement_map对每个sourceChecklist.id恰好一项，所有项必须含id/action/targets/reason。',
    '映射模板：{"id":"F1","action":"change","targets":["实际改动的token"],"reason":"对应的改动"}；{"id":"F2","action":"keep","targets":["实际已满足的token"],"reason":"已满足"}；{"id":"F3","action":"internal","targets":[],"reason":"仅制作流程"}；{"id":"F4","action":"superseded","targets":[],"superseded_by":"较新用户要求ID","reason":"明确被撤销"}。change组须包含该要求全部需修改的对象，修改对象在changes中列出，组内至少一个真实差分；同组可列未改对象作为已有依据，不必提交冗余写入，更不能改坏正确文字。keep仅列最少充分的目标；全稿不存在某类无依据内容等否定或来源边界可返回{"id":"F5","action":"keep","targets":[],"scope":"whole_deck","reason":"逐页检查后全稿已满足该边界"}，不虚构单对象证据，也不把业务边界当作internal制作流程。整稿独立审阅仍须核验该断言。没有明确撤销则不使用superseded。无匹配则changes=[]并说明原因。',
  ].join('\n'),messages:[{role:'user',content:JSON.stringify({mode:'amend',base,sourceChecklist,pages})},...(feedback?[{role:'user',content:'整稿独立审阅反馈，请据原始要求修改当前候选，未列对象保留当前文字：'+feedback}]:[])]},v=>{if(v.mode!=='amend'||!v.base||Object.keys(v.base).length!==3||Object.entries(base).some(([key,value])=>v.base[key]!==value)) return '必须mode=amend并逐字回传当前base，不能使用旧候选或完整替换：'+JSON.stringify(base);try{return revisionPlanIssue(v,targets,sourceChecklist);}catch(error){return error.message;}});
  return {...proposal,execution_changes:compileRevisionTargets(proposal,targets)};
}
function compactShape(e) {
  return {shape_id:String(e.shape_id??''),name:e.name,text:e.text||'',editable_text:!!e.editable_text,...(e.children?{children:e.children.map(compactShape)}:{}),...(e.cells?{cells:e.cells}:{})};
}
export async function reviseFromInstruction(id,text,modelId,opts={}) {
  return withPptOperation(()=>reviseFromInstructionCore(id,text,modelId,opts));
}
async function reviseFromInstructionCore(id,text,modelId,opts={}) {
  const cur=await currentVersion(id); assertBase(cur,opts);
  const insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
  const explicit=String(text).match(/第\s*(\d+)\s*页/);
  if(explicit && (!insp?.slides?.[Number(explicit[1])-1])) throw apiError('INVALID_OPERATION','指令页码超出当前 PPT');
  const projectMeta=(await loadProject(id)).meta;
  const model=await resolveModel(modelId || projectMeta.dialogue_model);
  if(!model.online) throw apiError('LLM_UNAVAILABLE','修订模型不可用：'+model.reason);
  const brief=await loadBrief(id);
  const source={userInstructions:groundedText(text),priorInstructions:groundedText(brief?.user_instructions||''),history:(await readJsonl(path.join(projectDir(id),'conversation.jsonl'))).filter(m=>m.role==='user'&&(m.epoch||0)===(projectMeta.epoch||0)).map(m=>groundedText(m.text)),materials:await originalMaterials(id),original:insp.slides.map(s=>({page:s.number,shapes:s.elements.map(compactShape)}))};
  const targets=revisionTargets(insp.slides);
  const sourceChecklist=reviewChecklist('revision',source);
  let candidateTargets=targets;
  const parsed=await reviewDraft({model,advisory:true,stage:'revision',projectId:id,source,
    draft:async feedback=>{
      const proposal=await draftRevision(model,candidateTargets,sourceChecklist,feedback,{version:cur.label,sha256:cur.sha256});
      candidateTargets=amendRevisionTargets(candidateTargets,proposal.changes);
      const cumulative=candidateTargets.filter(t=>t.text!==targets.find(original=>original.target===t.target).text).map(({target,text})=>({target,text}));
      return {...proposal,execution_changes:compileRevisionTargets({changes:cumulative},targets)};
    },
    visible:value=>({reply:value.reply,slides:source.original.map(s=>({...s,shapes:s.shapes.map(e=>({...e,text:value.execution_changes.find(c=>c.slide===s.page&&c.shape_id===e.shape_id)?.text??e.text}))}))})});
  if(!parsed.execution_changes.length) throw apiError('PPT_QUALITY_REJECTED','修订未产生任何可执行修改：'+(parsed.reply||''));
  const operations=parsed.execution_changes.map((c)=>({op:'set-text',slide:Number(c.slide),shape_id:String(c.shape_id),text:c.text}));
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
