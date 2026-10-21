import { resolveModel } from './llm.js';
import path from 'node:path';
import { reviewDraft, reviewChecklist, originalMaterials, groundedText, currentDraftReview, requirementVerificationIssue } from './quality.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config } from './config.js';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, readJsonl, writeJson, sha256File, nowIso, apiError, stableHash } from './util.js';
import { studio as studioRun, buildDeck } from './studio.js';
import { renderPptxToPngs } from './render.js';
import { buildIndex, invalidateIndex } from './index-builder.js';
import { getPlan } from './planner.js';
import { loadOutline } from './outline.js';
import { loadBrief, briefSummary } from './brief.js';
import { createJob, getJob, startJob, setStep, listJobs } from './jobs.js';
import { withProjectLock, withPptOperation, checkCancelled, beginCommit, markCommitted, operationJob } from './workflow.js';
import { planFingerprint } from './dependencies.js';
import { generateSlideContent, detailedOperations, textBoxSize } from './slide-content.js';
export const GEN_STEPS = ['生成逐页正文与构建操作','构建 PPTX','结构巡检','渲染预览与报告'];
export async function resolveTemplateDir(family) {
  const root=path.join(config().dataDir,'library','templates');
  const names={'green-clean-business':'绿色简洁商务','green-office-illustrated':'绿色办公插画'};
  for (const dir of await fsp.readdir(root)) {
    const m=await readJson(path.join(root,dir,'manifest.json'),null);
    if (m && (dir===family || m.id===family || m.name===names[family] || m.family===family)) {
      if(m.status!=='approved') throw apiError('TEMPLATE_NOT_APPROVED','模板尚未批准：'+m.name);
      const source=path.join(root,dir,'reference.pptx');
      if(await sha256File(source)!==m.source_sha256) throw apiError('SOURCE_HASH_MISMATCH','模板原件发生变化');
      return path.join(root,dir);
    }
  }
  throw apiError('SOURCE_NOT_FOUND','找不到已批准模板：'+family);
}
export function fillOperations(page, slide, outIndex, content) {
  if(content) return detailedOperations(page,slide,outIndex,content);
  const shapes=(slide.elements||[]).filter((e)=>e.editable_text && e.kind==='sp');
  if(shapes.length<2) throw apiError('UNSUPPORTED_OBJECT','版式没有标题和正文文本字段，不能完整填充');
  const title=shapes.find((e)=>/标题|题|title/i.test(e.name||''))||shapes[0];
  const body=shapes.filter((e)=>e!==title && !/页码|日期|编号|logo|version/i.test(e.name||''));
  if(!body.length) throw apiError('UNSUPPORTED_OBJECT','版式没有正文容量');
  const lines=(page.key_points||[]).map(String);
  const assigned=new Map(body.map((e)=>[e,[]]));
  // Allocate whole points before rendering; a wide, shallow caption is not a full-page body.
  const capacity=(e,text)=>{
    const {width,height}=textBoxSize(e);
    for(let size=18;size>=8;size-=0.25) {
      const rows=text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((w,c)=>w+(/[^\u0000-\u007f]/.test(c)?1:0.65),0)*size/width)),0);
      if(rows*size*1.4<=height) return size;
    }
    return 0;
  };
  for(const line of [...lines].sort((a,b)=>b.length-a.length)) {
    const candidates=body.map((e)=>({e,size:capacity(e,[...assigned.get(e),line].join('\n'))})).filter((c)=>c.size);
    candidates.sort((a,b)=>b.size-a.size || assigned.get(a.e).length-assigned.get(b.e).length);
    if(!candidates.length) throw apiError('UNSUPPORTED_OBJECT','第'+outIndex+'页正文超过模板容量，请调整内容或选择更大版式');
    assigned.get(candidates[0].e).push(line);
  }
  const ops=shapes.map((e)=>({op:'set-text',slide:outIndex,shape_id:e.shape_id,text:e===title?String(page.title):(assigned.get(e)||[]).sort((a,b)=>lines.indexOf(a)-lines.indexOf(b)).join('\n')}));
  // Unmapped sample tables/charts are removed, never represented as filled business data.
  for(const e of slide.elements||[]) if(['table','chart'].includes(e.kind)) ops.push({op:'delete-shape',slide:outIndex,shape_id:e.shape_id});
  return ops;
}
export async function prepareBuildPlan(projectId,phase='sample') {
  if(!['sample','final'].includes(phase)) throw apiError('INVALID_OPERATION','phase 必须为 sample 或 final');
  if(phase==='final') {
    const samples=await validateSampleApproval(projectId),{meta}=await loadProject(projectId);
    const inspection=await readJson(path.join(projectDir(projectId),'inspection-'+meta.version+'.json'),null);
    if(!inspection?.slides?.length) throw apiError('SOURCE_NOT_FOUND','当前已确认草稿缺少实际页面');
    return {phase,approvals:{samples},slides:inspection.slides.map(s=>({page:s.number}))};
  }
  const plan=await getPlan(projectId);
  if(!plan || plan.input_fingerprint!==await planFingerprint(projectId)) throw apiError('STATE_REVISION_CONFLICT','执行计划已过期，请更新计划');
  const brief=await loadBrief(projectId),outline=await loadOutline(projectId);
  const approvals={requirements:brief?.approvals?.requirements,outline:outline?.approvals?.outline};
  if(!approvals.requirements || !approvals.outline) throw apiError('REQUIRED_FIELD_MISSING','需要自动补齐需求及大纲记录');
  if(phase==='final') approvals.samples=await validateSampleApproval(projectId);
  const prepare=async feedback=>{
  const index=await buildIndex(), slides=[], inspections=new Map();
  for(const p of plan.pages) {
    const lay=index.layouts.find((l)=>l.id===p.layout_id);
    if(!lay || lay.approval!=='approved' || lay.pack==='reference_pack' || !lay.template_slide) throw apiError('UNSUPPORTED_OBJECT','版式不可生成：'+p.layout_id);
    const dir=await resolveTemplateDir(lay.template_id || lay.family);
    let insp=inspections.get(dir);
    if(!insp) {
      insp=await readJson(path.join(dir,'inspection.json'),null);
      if(insp?.text_capacity_schema!==1) {
        // Legacy inspections omit native insets; leave approved template files untouched.
        const output=path.join(projectDir(projectId),'template-inspection-'+path.basename(dir)+'.json');
        await studioRun(['inspect','--source',path.join(dir,'reference.pptx'),'--output',output]);
        insp=await readJson(output,null);
      }
      inspections.set(dir,insp);
    }
    const slide=insp?.slides?.[lay.template_slide-1];
    if(!slide) throw apiError('INVALID_OPERATION','模板页号越界：'+lay.template_slide);
    if(lay.source_template_sha && lay.source_template_sha!==await sha256File(path.join(dir,'reference.pptx'))) throw apiError('SOURCE_HASH_MISMATCH','计划模板已变化');
    const content=phase==='sample'?await generateSlideContent(projectId,p,slide,feedback):null;
    slides.push({source_slide:lay.template_slide,source_template:dir,operations:fillOperations(p,slide,slides.length+1,content)});
    if(operationJob()) setStep(operationJob(),0,Math.round(slides.length/plan.pages.length*35));
  }
  return {phase,approvals,slides};
  };
  const {meta}=await loadProject(projectId);
  // Planner summaries are context, never substitutes for authorized original facts.
  const source=phase==='sample'?{requirements:briefSummary(brief),userInstructions:groundedText(brief?.user_instructions||''),history:(await readJsonl(path.join(projectDir(projectId),'conversation.jsonl'))).filter(m=>m.role==='user'&&(m.epoch||0)===(meta.epoch||0)).map(m=>groundedText(m.text)),materials:await originalMaterials(projectId)}:null;
  if(source&&!reviewChecklist('deck',source,{human:true}).length) throw apiError('REQUIRED_FIELD_MISSING','缺少可核对的用户原文或原始材料，请补充实际业务要求后生成');
  const out=phase==='final'?await prepare(''):await reviewDraft({model:await resolveModel(meta.dialogue_model),advisory:true,stage:'deck',projectId,source,draft:prepare,visible:value=>({slides:value.slides.map((s,i)=>({page:i+1,operations:s.operations}))})});
  await writeJson(path.join(projectDir(projectId),'build-plan.json'),out);
  return out;
}
export async function nextVersionLabel(projectId) {
  const dir=path.join(projectDir(projectId),'versions'); await fsp.mkdir(dir,{recursive:true});
  const nums=(await fsp.readdir(dir)).map((f)=>f.match(/^revision-(\d+)\.pptx$/)?.[1]).filter(Boolean).map(Number);
  const n=Math.max(0,...nums)+1;
  return {label:'v'+String(n).padStart(4,'0'),file:'revision-'+String(n).padStart(3,'0')+'.pptx'};
}
async function actualPlanHash(id) { return stableHash((await getPlan(id))?.pages || []); }
export async function validateSampleApproval(id) {
  const {meta}=await loadProject(id), approval=await readJson(path.join(projectDir(id),'sample-approval.json'),null);
  if(!approval || approval.version!==meta.version || approval.sha256!==meta.source_sha256) throw apiError('REQUIRED_FIELD_MISSING','请先确认当前实际样张，再执行正式定稿');
  const current=await currentDraftReview(id,meta),issue=requirementVerificationIssue(current,approval.requirement_review);
  if(issue) throw Object.assign(apiError('PPT_REQUIREMENTS_UNVERIFIED',issue),{details:{draft_review:current}});
  if(approval.input_fingerprint!==await planFingerprint(id) || approval.plan_hash!==await actualPlanHash(id)) throw apiError('REQUIRED_FIELD_MISSING','请先确认当前实际样张，再执行正式定稿');
  return approval;
}
export async function confirmSamples(id,{version,sha256,confirmed_by,note,requirement_review}={}) {
  return withProjectLock(id,async()=>{
    const {meta}=await loadProject(id);
    if(!version || !sha256 || !confirmed_by || !note) throw apiError('REQUIRED_FIELD_MISSING','确认样张需要当前版本、SHA、确认人和说明');
    if(version!==meta.version || sha256!==meta.source_sha256) throw apiError('SOURCE_HASH_MISMATCH','样张已变化，请重新查看');
    const report=await readJson(path.join(projectDir(id),meta.latest_report || ''),null);
    if(report?.render!=='pass' || report?.structural!=='pass') throw apiError('INVALID_OPERATION','样张尚未完整生成和渲染');
    const draft_review=await currentDraftReview(id,meta),issue=requirementVerificationIssue(draft_review,requirement_review);
    if(issue) throw Object.assign(apiError('PPT_REQUIREMENTS_UNVERIFIED',issue),{details:{draft_review}});
    const record={version,sha256,confirmed_by,note,requirement_review,at:nowIso(),input_fingerprint:await planFingerprint(id),plan_hash:await actualPlanHash(id)};
    await writeJson(path.join(projectDir(id),'sample-approval.json'),record); return record;
  });
}
export async function startGenerate(projectId,{phase='sample'}={}) {
  return withPptOperation(()=>startGenerateCore(projectId,{phase}));
}
async function startGenerateCore(projectId,{phase='sample'}={}) {
  return withProjectLock(projectId,async()=>{
    const {meta}=await loadProject(projectId);
    if(listJobs(projectId).some((j)=>['queued','running'].includes(j.status))) throw apiError('INVALID_OPERATION','已有任务，请等待或取消');
    if(phase==='final') await validateSampleApproval(projectId);
    const plan=await getPlan(projectId); if(!plan) throw apiError('REQUIRED_FIELD_MISSING','尚无执行计划');
    const fingerprint=await planFingerprint(projectId);
    const job=createJob('generate',projectId,{phase,steps:GEN_STEPS});
    await updateProjectMeta(projectId,{stage:'generating',active_job:job.id,next_action:'生成中'});
    startJob(job,async(j)=>withProjectLock(projectId,async()=>{
      let outPptx;
      try {
        checkCancelled(); setStep(j,0);
        const buildPlan=await prepareBuildPlan(projectId,phase);
        const ver=await nextVersionLabel(projectId);
        outPptx=path.join(projectDir(projectId),'versions',ver.file);
        setStep(j,1);
        if(phase==='final') await fsp.copyFile(path.join(projectDir(projectId),'versions',meta.source_name),outPptx,fs.constants.COPYFILE_EXCL);
        else await buildDeck(buildPlan.slides[0].source_template,path.join(projectDir(projectId),'build-plan.json'),outPptx);
        checkCancelled(); setStep(j,2);
        const requiredPages=phase==='sample'?plan.pages.map((p,i)=>({...p,key_points:buildPlan.slides[i].operations.filter(o=>['set-text','table-cell','insert-text'].includes(o.op)&&o.text).map(o=>o.text)})):null;
        const result=await finalizeVersion(projectId,outPptx,{phase,label:ver.label,file:ver.file,expectedSlides:buildPlan.slides.length,expectedFingerprint:fingerprint,requiredPages,approvedSample:phase==='final'?buildPlan.approvals.samples:undefined});
        setStep(j,3,99); return result;
      } catch(e) {
        if(outPptx && !j.committed) await discardUncommitted(projectId,outPptx);
        await updateProjectMeta(projectId,{stage:meta.version?'done':'pages',active_job:null,next_action:'重试生成：'+e.message}).catch(()=>{});
        throw e;
      }
    }));
    return {job_id:job.id};
  });
}
export { getJob };
export async function discardUncommitted(id, pptx) {
  const {meta,state}=await loadProject(id);
  if(meta.source_name===path.basename(pptx)) return;
  const n=path.basename(pptx).match(/revision-(\d+)/)?.[1];
  const label='v'+String(Number(n)).padStart(4,'0');
  await Promise.all([pptx,path.join(projectDir(id),'inspection-'+label+'.json'),path.join(projectDir(id),'report-'+label+'.json'),path.join(projectDir(id),'renders',label)].map(p=>fsp.rm(p,{recursive:true,force:true})));
  const renders={...(state.renders||{})}; delete renders[label];
  await writeJson(path.join(projectDir(id),'state.json'),{...state,renders});
}
export async function startRender(id) {
  return withProjectLock(id,async()=>{
    const {meta}=await loadProject(id);
    if(!meta.version || !meta.source_name) throw apiError('INVALID_OPERATION','尚无可渲染版本');
    if(listJobs(id).some((j)=>['queued','running'].includes(j.status))) throw apiError('INVALID_OPERATION','已有任务正在运行');
    const job=createJob('render',id,{steps:GEN_STEPS});
    startJob(job,async(j)=>withProjectLock(id,async()=>{setStep(j,2,50);return finalizeVersion(id,path.join(projectDir(id),'versions',meta.source_name),{phase:'preview',label:meta.version,file:meta.source_name,expectedSlides:meta.page_count});}));
    return {job_id:job.id};
  });
}
export async function finalizeVersion(projectId,outPptx,{phase,label,file,expectedSlides,expectedFingerprint,requiredPages,approvedSample}={}) {
  return withProjectLock(projectId,async()=>{
    checkCancelled();
    const dir=projectDir(projectId), inspPath=path.join(dir,'inspection-'+label+'.json');
    await studioRun(['inspect','--source',outPptx,'--output',inspPath]);
    const insp=await readJson(inspPath,{}), slideCount=insp.slides?.length || 0;
    if(!slideCount || (expectedSlides && slideCount!==expectedSlides)) throw apiError('INVALID_OPERATION','实际页数与计划不一致');
    if(requiredPages) for(let i=0;i<requiredPages.length;i++) {
      const text=(insp.slides[i].elements||[]).map((e)=>e.text||'').join('\n');
      const missing=[requiredPages[i].title,...requiredPages[i].key_points].filter((t)=>!text.includes(t));
      if(missing.length) throw apiError('INVALID_OPERATION','第'+(i+1)+'页缺少内容：'+missing.join('；'));
      if(/构造的样式演示数据|不代表实际业务效果|示例业务数据/.test(text)) throw apiError('INVALID_OPERATION','输出仍包含模板示例文字');
    }
    if(operationJob()) setStep(operationJob(),3,75);
    const render=await renderPptxToPngs(outPptx,path.join(dir,'renders',label));
    if(render.files?.length!==slideCount) throw apiError('RENDER_FAILED','预览页数不完整');
    checkCancelled();
    if(expectedFingerprint && expectedFingerprint!==await planFingerprint(projectId)) throw apiError('STATE_REVISION_CONFLICT','生成输入已变化，未提交版本');
    const sha=await sha256File(outPptx);
    if(phase==='final'&&(!approvedSample||approvedSample.sha256!==sha)) throw apiError('SOURCE_HASH_MISMATCH','定稿文件与已确认的实际草稿不同，未提交');
    const previous=phase==='preview'?await readJson(path.join(dir,'report-'+label+'.json'),null):null;
    const proof=approvedSample||(previous?.phase==='final'&&previous.sha256===sha?previous.approved_sample:undefined);
    const documentPhase=phase==='preview'&&proof?'final':phase;
    const report={project_id:projectId,version:label,phase:documentPhase,approved_sample:proof,file:'versions/'+file,sha256:sha,slide_count:slideCount,
      editable_pages:insp.slides.filter((s)=>s.elements.some((e)=>e.editable_text)).length,engine:render.engine,
      engine_version:render.engine_version,render:'pass',render_pngs:render.files.map((f)=>'renders/'+label+'/'+f.file),
      structural:'pass',content:requiredPages?'pass':'not_checked',checked_at:nowIso()};
    await writeJson(path.join(dir,'report-'+label+'.json'),report);
    beginCommit();
    const {state}=await loadProject(projectId);
    await writeJson(path.join(dir,'state.json'),{...state,revision:Number(label.slice(1)),current:'versions/'+file,current_sha256:sha,
      renders:{...(state.renders||{}),[label]:report.render_pngs}});
    await updateProjectMeta(projectId,{status:'active',stage:'done',version:label,source_name:file,source_sha256:sha,
      page_count:slideCount,active_job:null,latest_report:'report-'+label+'.json',last_render_engine:render.engine,last_render_engine_version:render.engine_version,
      checks:{structural:'pass',render:'pass',visual_review:'pending',editability:report.editable_pages?'pass':'pending',user_acceptance:proof?'confirmed':'pending'},document_state:documentPhase==='final'?'final':'draft',next_action:documentPhase==='final'?'已确认定稿，可预览下载':'草稿待预览、修改及要求核实'});
    markCommitted(); invalidateIndex();
    return {version:label,file,sha256:sha,slide_count:slideCount,editable_pages:report.editable_pages,report};
  });
}
