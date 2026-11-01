import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, nowIso, apiError, sha256File } from './util.js';
import { patchSource, inspectSource } from './studio.js';
import { resolveModel, chatJson } from './llm.js';
import { nextVersionLabel, finalizeVersion, discardUncommitted } from './generate.js';
import { withProjectLock, withPptOperation, withJobScope } from './workflow.js';
import { loadBrief } from './brief.js';
import { readJsonl, stableHash } from './util.js';
import { reviewDraft, groundedText, originalMaterials, reviewChecklist } from './quality.js';
import { runComponentCommand, resolveComponentImageAsset } from './component-service.js';
import { operationSignal } from './workflow.js';
import { renderPptxToPngs } from './render.js';
import { config } from './config.js';
import { createJob, startJob, listJobs, setStep } from './jobs.js';
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
  const {meta}=await loadProject(id);
  const state=meta.component_state_path?await readJson(path.join(projectDir(id),meta.component_state_path),null):null;
  if(meta.component_state_path&&(!state||state.sha256!==cur.sha256)) throw apiError('SOURCE_HASH_MISMATCH','组件状态与当前 PPTX 不一致，请重新导入');
  const componentSlide=state?.slides?.[n-1],planSlide=state?.plan?.slides?.[n-1];
  const locks=planSlide?.locks||[];
  const catalog=state?await readJson(path.join(config().dataDir,'library','components','index.json'),null):null;
  const intersects=(a,b)=>a.x<b.x+b.width-.1&&b.x<a.x+a.width-.1&&a.y<b.y+b.height-.1&&b.y<a.y+a.height-.1;
  return {version:cur.label,sha256:cur.sha256,page:n,slide_count:insp.slides.length,slide_size:insp.slide_size,
    shapes:slide.elements.map((e)=>({...e,shape_id:String(e.shape_id)})),
    ...(state?{component_state_revision:state.revision,slide_id:componentSlide?.slide_id,locks,
      components:(planSlide?.instances||[]).map(instance=>{
        const actual=componentSlide?.instances?.find(item=>item.instance_id===instance.instance_id);
        const descriptor=catalog?.components?.find(c=>c.component_id===instance.component_id&&c.component_version===instance.component_version);
        return {...instance,shape_ids:actual?.shape_ids||[],maps:actual?.maps||[],actual_source_ref:actual?.actual_source_ref||null,
          lifecycle:descriptor?.lifecycle||null,quality_status:descriptor?.quality_status||null,
          parameterization:descriptor?.parameterization||null,slots:descriptor?.slots||[],editability:descriptor?.editability||null,
          preview:descriptor?.preview||null,
          locked:locks.some(lock=>lock.instance_id===instance.instance_id||lock.rect&&intersects(instance.rect,lock.rect))};
      })}:{}),
  };
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
export function componentRevisionIssue(value,state) {
  const base=value?.base;
  if(base?.expected_sha256!==state.sha256||base?.expected_revision!==state.revision) return '基准SHA或组件修订号已变化';
  if(!Array.isArray(value.operations)||!value.operations.length||value.operations.length>1000) return '需要 1–1000 项组件修订操作';
  const actions=new Set(['set-binding','set-node-count','set-arrangement','set-geometry','set-title','replace-component','lock-component','unlock-component','lock-region','unlock-region','regenerate-region','set-text','replace-text','geometry','table-cell']);
  for(const op of value.operations) {
    if(!op||typeof op.op!=='string') return '每项操作必须包含op字段，不是type字段；合法op：'+[...actions].join('、');
    if(!actions.has(op.op)) return '不支持的op：'+op.op+'；合法op：'+[...actions].join('、');
    const page=state.slides?.find(s=>s.slide_id===op.slide_id);
    if(!page) return '未知组件页 ID';
    const instance=page.instances?.find(i=>i.instance_id===op.instance_id);
    const plan=state.plan?.slides?.find(s=>s.slide_id===op.slide_id);
    if(op.discard_native_edits) return '模型不能自行丢弃原生几何调整';
    if(['set-text','replace-text','geometry','table-cell'].includes(op.op)) {
      const shapeId=String(op.shape_id);
      const imported=page.instances?.some(i=>i.shape_ids?.includes(shapeId)||i.maps?.some(m=>Object.values(m.id_map||{}).includes(shapeId)));
      const title=shapeId===String(page.title_shape_id)&&['set-text','replace-text'].includes(op.op);
      const original=page.originals?.find(item=>String(item.shape_id)===shapeId);
      const native=original&&(op.op==='geometry'&&['text','shape','image'].includes(original.kind)||
        ['set-text','replace-text'].includes(op.op)&&['text','shape'].includes(original.kind));
      if(!imported&&!title&&!native) return '原生对象 ID 不属于当前组件页';
    } else if(['lock-region','unlock-region'].includes(op.op)) {
      if(typeof op.lock_id!=='string'||!op.lock_id||op.op==='lock-region'&&(!op.rect||['x','y','width','height'].some(k=>!Number.isFinite(op.rect[k])))) return '区域锁 ID 或坐标无效';
    } else if(op.op!=='set-title'&&op.op!=='regenerate-region'&&!instance) return '未知组件实例 ID';
    if(op.op==='set-node-count'&&(!Number.isInteger(op.count)||!Array.isArray(op.items)||op.items.length!==op.count||op.items.some(item=>!item||typeof item.title!=='string'||!item.title.trim()))) return '节点数量必须附完整节点内容';
    if(op.op==='set-arrangement'&&!['horizontal','vertical','two_rows','grid','radial'].includes(op.arrangement)) return '排列方式无效';
    if(op.op==='regenerate-region'&&(!op.rect||!Array.isArray(op.instances)||!op.instances.length)) return '局部重生成必须有区域及完整替换实例';
    if(['unlock-component','lock-component'].includes(op.op)&&!plan?.instances?.some(i=>i.instance_id===op.instance_id)) return '未知组件实例 ID';
  }
}
async function reviseComponentInstruction(id,text,modelId,opts,cur,state,insp) {
  const meta=(await loadProject(id)).meta,model=await resolveModel(modelId||meta.dialogue_model);
  if(!model.online) throw apiError('LLM_UNAVAILABLE','修订模型不可用：'+model.reason);
  const brief=await loadBrief(id);
  const base={expected_sha256:cur.sha256,expected_revision:state.revision};
  const slides=state.plan.slides.map((plan,i)=>({slide_id:plan.slide_id,title:plan.title,title_shape_id:state.slides[i].title_shape_id,
    locks:plan.locks||[],originals:(state.slides[i].originals||[]).map(({shape_id,original_id,kind,text,rect})=>({shape_id,original_id,kind,text,rect})),
    instances:plan.instances.map(instance=>({instance_id:instance.instance_id,component_id:instance.component_id,
      rect:instance.rect,bindings:instance.bindings,transform:instance.transform,shape_ids:state.slides[i].instances.find(s=>s.instance_id===instance.instance_id)?.shape_ids||[]})),
    shapes:(insp.slides[i]?.elements||[]).map(e=>({shape_id:String(e.shape_id),text:e.text||'',editable_text:!!e.editable_text}))}));
  const source={instruction:groundedText(text),prior_instructions:groundedText(brief?.user_instructions||''),materials:await originalMaterials(id),slides};
  const proposal=await chatJson({model,timeoutMs:600000,
    system:'你是PPT修订作者。只依据用户要求、真实材料和当前组件/形状ID规划修改。返回JSON {base,operations,reply}；operations每项必须用op字段，不能用type字段。标题操作示例：'+JSON.stringify({op:'set-title',slide_id:slides[0].slide_id,text:'实际新标题'})+'；示例只说明字段，目标slide_id必须从slides选，文字必须符合用户实际要求。未修改的对象不要列入operations。组件操作可用 set-binding、set-node-count（必须带count和完整items节点标题及内容）、set-arrangement、set-geometry、set-title、replace-component、lock-component、unlock-component、lock-region、unlock-region、regenerate-region；原生对象仍可 set-text、replace-text、geometry、table-cell。所有操作使用给定slide_id和instance_id或当前页真实输出shape_id；独立标题使用set-title。锁保护的对象和区域不能修改；不得自动解除锁、猜测来源、丢弃原生几何编辑或使用外部文件路径。修改几何后语义重建须要求用户先重提取或明确选择discard，不可自行设置discard_native_edits。只返回有实际修改的操作。',
    messages:[{role:'user',content:JSON.stringify({base,...source})}]},value=>componentRevisionIssue(value,state));
  const result=await applyPatch(id,proposal.operations,{...base,request_id:opts.request_id||'dialogue-'+(await import('node:crypto')).randomUUID(),source:'dialogue',note:proposal.reply||text});
  return {...result,applied:true,reply:proposal.reply,via:'llm',model:{id:model.id,tag:model.tag}};
}
export async function draftRevision(model,targets,sourceChecklist,feedback='',originalVersion) {
  if(!targets.length) throw apiError('INVALID_OPERATION','没有可编辑文字目标');
  const base=revisionCandidateBase(targets,originalVersion);
  const pages=[...new Set(targets.map(t=>t.slide))].map(page=>({page,targets:targets.filter(t=>t.slide===page).map(({target,name,text})=>({target,name,text}))}));
  const proposal=await chatJson({model,schema:revisionSchema(base,targets,sourceChecklist),timeoutMs:600000,system:[
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
  const {meta:revisionMeta}=await loadProject(id);
  const componentState=revisionMeta.component_state_path ? await readJson(path.join(projectDir(id),revisionMeta.component_state_path),null) : null;
  if(revisionMeta.component_state_path && (!componentState || componentState.sha256!==cur.sha256)) throw apiError('SOURCE_HASH_MISMATCH','组件状态与当前 PPTX 不一致，请重新导入');
  const insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
  if(componentState) return reviseComponentInstruction(id,text,modelId,opts,cur,componentState,insp);
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
  const result=await applyPatch(id,operations,{version:cur.label,expected_sha256:cur.sha256,expected_revision:componentState?.revision,
    request_id:opts.request_id||'dialogue-'+(await import('node:crypto')).randomUUID(),source:'dialogue',note:parsed.reply||text});
  return {...result,applied:true,reply:parsed.reply,via:'llm',model:{id:model.id,tag:model.tag}};
}
export async function applyPatch(id,operations,opts={}) {
  if ((await loadProject(id)).meta.component_state_path) {
    return withProjectLock(id,async()=>{
      const pending=await applyComponentRevision(id,{expected_sha256:opts.expected_sha256,expected_revision:opts.expected_revision,
        operations,request_id:opts.request_id});
      return pending.file&&pending.report?pending:prepareComponentRevision(id,pending);
    });
  }
  return withProjectLock(id,async()=>{
    const cur=await currentVersion(id); assertBase(cur,opts);
    if(!Array.isArray(operations)||!operations.length||operations.length>1000) throw apiError('INVALID_OPERATION','需要 1–1000 项操作');
    const insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
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
        op.asset_path=await resolveComponentImageAsset(id,op.asset_id);
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
const revisionReceipts=id=>path.join(projectDir(id),'revision-requests.json');
async function readRevisionReceipts(id) {
  try {return JSON.parse(await fsp.readFile(revisionReceipts(id),'utf8'));}
  catch(error) {if(error.code==='ENOENT') return {};throw error;}
}
export async function startPatchJob(id,operations,opts={}) {
  return withProjectLock(id,async()=>{
    const {meta}=await loadProject(id),request_id=opts.request_id;
    if(typeof request_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(request_id)||['__proto__','constructor','prototype'].includes(request_id)) throw apiError('INVALID_OPERATION','修订任务需要稳定请求号');
    const existing=listJobs(id).find(job=>job.type==='patch'&&job.meta?.request_id===request_id);
    if(existing) {
      if(existing.meta.input_fingerprint!==stableHash({base:existing.meta.base,operations})) throw apiError('REQUEST_CONFLICT','相同请求号的修订内容不同');
      if(opts.expected_sha256!==existing.meta.base.expected_sha256||opts.expected_revision!==existing.meta.base.expected_revision||opts.version!==existing.meta.base.version) throw apiError('REQUEST_CONFLICT','相同请求号的基准版本不同');
      return {job_id:existing.id};
    }
    const cur=await currentVersion(id);assertBase(cur,opts);
    const base={version:cur.label,expected_sha256:cur.sha256,expected_revision:opts.expected_revision};
    if(meta.component_state_path) {
      const state=await readJson(path.join(projectDir(id),meta.component_state_path),null);
      if(!state||state.sha256!==cur.sha256||state.revision!==base.expected_revision) throw apiError('STATE_REVISION_CONFLICT','组件基准版本已变化');
    }
    if(listJobs(id).some(job=>['queued','running'].includes(job.status))) throw apiError('INVALID_OPERATION','已有写任务正在运行');
    const job=createJob('patch',id,{request_id,base,input_fingerprint:stableHash({base,operations}),steps:['修订原生文件','检查并提交版本']});
    startJob(job,async j=>withProjectLock(id,async()=>{
      setStep(j,0,10);
      const result=await applyPatch(id,operations,{...opts,...base});
      setStep(j,1,95);
      return result;
    }));
    job.completion.then(()=>withJobScope(null,async()=>{
      if(job.status==='done') {
        const {processPendingInputs}=await import('./dialogue.js');
        await processPendingInputs(id);
      }
    })).catch(async error=>{await updateProjectMeta(id,{next_action:'待处理输入已保留：'+error.message});});
    return {job_id:job.id};
  });
}
export async function applyComponentRevision(id,{expected_sha256,expected_revision,operations,request_id}={}) {
  return withProjectLock(id,async()=>{
    const {meta}=await loadProject(id);
    if(!meta.component_state_path) throw apiError('INVALID_OPERATION','当前项目没有组件状态');
    if(!Number.isInteger(expected_revision)) throw apiError('INVALID_OPERATION','缺少组件修订号');
    if(!Array.isArray(operations)||!operations.length||operations.length>1000||operations.some(op=>!op||typeof op!=='object'||Array.isArray(op))) throw apiError('INVALID_OPERATION','需要 1–1000 项操作');
    if(typeof request_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(request_id)||['__proto__','constructor','prototype'].includes(request_id)) throw apiError('INVALID_OPERATION','缺少修订请求 ID');
    const request_fingerprint=stableHash({expected_sha256,expected_revision,operations});
    const receipts=await readRevisionReceipts(id),receipt=Object.hasOwn(receipts,request_id)?receipts[request_id]:null;
    if(receipt) {
      if(receipt.fingerprint!==request_fingerprint) throw apiError('REQUEST_CONFLICT','相同请求号的基准或操作不同');
      return receipt.result;
    }
    const cur=await currentVersion(id);
    if(!expected_sha256||expected_sha256!==cur.sha256) throw apiError('SOURCE_HASH_MISMATCH','基准文件已变化，请重新加载');
    const dir=projectDir(id),statePath=path.resolve(dir,meta.component_state_path);
    if(!statePath.startsWith(dir+path.sep)||!fs.existsSync(statePath)) throw apiError('SOURCE_NOT_FOUND','组件状态缺失，请重新导入');
    const componentState=await readJson(statePath,null);
    if(!componentState||componentState.sha256!==cur.sha256) throw apiError('SOURCE_HASH_MISMATCH','组件状态与当前 PPTX 不一致，请重新导入');
    if(componentState.revision!==expected_revision) throw apiError('STATE_REVISION_CONFLICT','组件版本已变化，请重新加载');
    const pending=(await fsp.readdir(path.join(dir,'versions'))).some(file=>{
      const n=file.match(/^revision-(\d+)\.pptx$/)?.[1];
      return n && Number(n)>Number(cur.label.slice(1));
    });
    if(pending) throw apiError('STATE_REVISION_CONFLICT','已有待检查修订，完成或取消后再编辑');
    const normalized=[];
    for(const op of operations) {
      let mapped=op;
      if(!op.slide_id) {
        if(!Number.isInteger(op.slide)||!componentState.slides?.[op.slide-1]) throw apiError('INVALID_OPERATION','操作页码或组件页 ID 无效');
        const {slide,...rest}=op;
        mapped={...rest,slide_id:componentState.slides[slide-1].slide_id};
      }
      const page=componentState.slides?.find(s=>s.slide_id===mapped.slide_id);
      if(!page) throw apiError('INVALID_OPERATION','操作组件页 ID 无效');
      if(String(mapped.shape_id)===String(page.title_shape_id)&&['set-text','replace-text'].includes(mapped.op)) {
        let title=mapped.text;
        if(mapped.op==='replace-text') {
          const original=componentState.plan.slides.find(s=>s.slide_id===page.slide_id).title||'';
          if(typeof mapped.old!=='string'||!mapped.old||!original.includes(mapped.old)||typeof mapped.new!=='string') throw apiError('INVALID_OPERATION','标题替换需要当前文字中的 old 和新文字');
          title=original.replace(mapped.old,mapped.new);
        }
        if(typeof title!=='string') throw apiError('INVALID_OPERATION','标题文字必须为字符串');
        mapped={op:'set-title',slide_id:page.slide_id,text:title};
      }
      if(mapped.op==='insert-image') {
        const asset_path=await resolveComponentImageAsset(id,mapped.asset_id);
        mapped={...mapped,asset_path};
      }
      normalized.push(mapped);
    }
    const ver=await nextVersionLabel(id),out=path.join(dir,'versions',ver.file);
    try {
      const response=await runComponentCommand(id,{command:'apply-revision',source:path.relative(dir,cur.path),state:path.relative(dir,statePath),
        output:path.relative(dir,out),expected_sha256,operations:normalized},{signal:operationSignal()});
      const result=response.result;
      if(result.output!==out||result.state!==out.replace(/\.pptx$/,'.state.json')||result.sha256!==await sha256File(out)||result.revision!==expected_revision+1) throw apiError('ENGINE_FAILED','组件修订结果与目标版本不一致');
      return {version:ver.label,state_revision:result.revision,pptx_path:out,sha256:result.sha256,
        component_state_path:result.state,request_id,request_fingerprint,expected_sha256,expected_revision};
    } catch(error) {
      await fsp.rm(out,{force:true});
      await fsp.rm(out.replace(/\.pptx$/,'.state.json'),{force:true});
      throw error;
    }
  });
}
export async function prepareComponentRevision(id,pending) {
  const dir=projectDir(id),out=path.resolve(pending.pptx_path);
  if(!/^v\d{4,}$/.test(pending.version)||out!==path.join(dir,'versions','revision-'+String(Number(pending.version.slice(1))).padStart(3,'0')+'.pptx')||
    pending.component_state_path!==out.replace(/\.pptx$/,'.state.json')) throw apiError('INVALID_OPERATION','待检查版本路径无效');
  const inspection='inspection-'+pending.version+'.json',layout='layout-audit-'+pending.version+'.json',preview='renders/'+pending.version+'/manifest.json';
  let committed=false;
  try {
    const state=await readJson(pending.component_state_path,null);
    if(!state||state.sha256!==pending.sha256) throw apiError('SOURCE_HASH_MISMATCH','修订状态与候选文件不一致');
    const audit=(await runComponentCommand(id,{command:'audit-visual',source:path.relative(dir,out),state:path.relative(dir,pending.component_state_path),plan:state.plan},{signal:operationSignal()})).result;
    await writeJson(path.join(dir,layout),audit);
    await inspectSource(out,path.join(dir,inspection));
    const render=await renderPptxToPngs(out,path.join(dir,'renders',pending.version));
    await writeJson(path.join(dir,preview),render);
    const full={...pending,inspection_path:inspection,layout_report_path:layout,preview_manifest:preview};
    const {checkDelivery}=await import('./quality.js');
    const checked=await checkDelivery(id,full,{signal:operationSignal()});
    const {commitGeneratedVersion}=await import('./generate.js');
    const result=await commitGeneratedVersion(id,full,checked);
    committed=true;
    if(pending.request_fingerprint) {
      const receipts=await readRevisionReceipts(id);
      receipts[pending.request_id]={fingerprint:pending.request_fingerprint,result};
      await writeJson(revisionReceipts(id),receipts);
    }
    return result;
  } catch(error) {
    if(!committed) await Promise.all([out,pending.component_state_path,path.join(dir,inspection),path.join(dir,layout),path.join(dir,'renders',pending.version)].map(file=>fsp.rm(file,{recursive:true,force:true})));
    throw error;
  }
}
export async function rollbackVersion(id,label,opts={}) {
  return withProjectLock(id,async()=>{
    const cur=await currentVersion(id); assertBase(cur,opts);
    if(!/^v\d{4,}$/.test(label||'') || label===cur.label) throw apiError('INVALID_OPERATION','请选择有效的其他版本');
    const src=path.join(projectDir(id),'versions','revision-'+String(Number(label.slice(1))).padStart(3,'0')+'.pptx');
    if(!fs.existsSync(src)) throw apiError('SOURCE_NOT_FOUND','回滚版本不存在');
    const {meta}=await loadProject(id);
    if(meta.component_state_path) {
      const previous=await readJson(src.replace(/\.pptx$/,'.state.json'),null);
      const current=await readJson(path.join(projectDir(id),meta.component_state_path),null);
      if(!previous||previous.sha256!==await sha256File(src)||!current||current.sha256!==cur.sha256) throw apiError('SOURCE_HASH_MISMATCH','版本对应的组件状态缺失或不一致');
      const ver=await nextVersionLabel(id),out=path.join(projectDir(id),'versions',ver.file),statePath=out.replace(/\.pptx$/,'.state.json');
      try {
        await fsp.copyFile(src,out,fs.constants.COPYFILE_EXCL);
        await writeJson(statePath,{...previous,revision:current.revision+1,parent_sha256:cur.sha256,output:out,request_id:'rollback-'+(await import('node:crypto')).randomUUID()});
        return {...await prepareComponentRevision(id,{version:ver.label,state_revision:current.revision+1,pptx_path:out,
          sha256:previous.sha256,component_state_path:statePath,expected_sha256:cur.sha256,expected_revision:current.revision}),rolled_back_to:label};
      } catch(error) {await fsp.rm(out,{force:true});await fsp.rm(statePath,{force:true});throw error;}
    }
    const ver=await nextVersionLabel(id),out=path.join(projectDir(id),'versions',ver.file);
    await fsp.copyFile(src,out,fs.constants.COPYFILE_EXCL);
    try { return {...await finalizeVersion(id,out,{phase:'sample',label:ver.label,file:ver.file}),rolled_back_to:label}; }
    catch(e){await discardUncommitted(id,out);throw e;}
  });
}
