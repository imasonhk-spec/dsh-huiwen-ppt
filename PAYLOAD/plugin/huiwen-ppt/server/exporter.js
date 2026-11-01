import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, sha256File, nowIso, apiError, stableHash } from './util.js';
import { withProjectLock } from './workflow.js';
import { currentDraftReview, requirementVerificationIssue, assertDeliveryReady, assertTemplateFillReady } from './quality.js';
import { invalidateIndex } from './index-builder.js';
export async function exportsRegistry(id) { return readJson(path.join(projectDir(id),'exports.json'),[]); }
const PROOF_CHECKS=['structure','bindings','source_mapping','deterministic_layout','render','editability'];
async function verifiedExportProof(id,entry) {
  if(entry.document_state==='ready'&&entry.kind==='template_fill') {
    const expected=path.join(path.dirname(entry.file),'delivery-proof.json');
    if(entry.proof_file!==expected||!entry.proof_sha256)throw apiError('DELIVERY_BLOCKED','历史原页导出缺少独立证明');
    try {
      const file=path.join(config().dataDir,expected);
      if(await sha256File(file)!==entry.proof_sha256)throw new Error('证明文件SHA不一致');
      const proof=await readJson(file,null),report=proof?.delivery;
      if(proof?.schema_version!==1||proof.kind!=='template_fill'||proof.project_id!==id||proof.export_id!==entry.id||
         proof.version!==entry.version||proof.source_sha256!==entry.sha256||proof.report_digest!==stableHash(report)||
         report?.profile!=='template_fill_non_visual_v1'||report.status!=='ready'||report.source_sha256!==entry.sha256||
         report.visual_review!=='not_run_user_paused'||report.blocking_errors?.length||
         ['structure','bindings','render','editability'].some(key=>report.checks?.[key]!=='passed')||
         report.render_text_evidence?.status!=='passed'||report.editability_evidence?.status!=='passed'||!Object.keys(report.artifact_sha256||{}).length)
        throw new Error('原页非视觉交付证明内容不一致');
    }catch(error){throw apiError('DELIVERY_BLOCKED','历史原页导出证明无效：'+error.message);}
    return;
  }
  if(entry.kind!=='compose'&&entry.document_state!=='ready') return;
  const expected=path.join(path.dirname(entry.file),'delivery-proof.json');
  if(entry.proof_file!==expected||!entry.proof_sha256) throw apiError('DELIVERY_BLOCKED','历史组件导出缺少独立交付证明');
  const proofPath=path.join(config().dataDir,expected);
  try {
    if(await sha256File(proofPath)!==entry.proof_sha256) throw new Error('证明文件SHA不一致');
    const proof=await readJson(proofPath);
    const report=proof?.delivery;
    if(proof.schema_version!==1||proof.kind!=='compose'||proof.project_id!==id||proof.export_id!==entry.id||proof.version!==entry.version||
       proof.source_sha256!==entry.sha256||proof.report_digest!==stableHash(report)||report?.profile!=='non_visual_v1'||
       report.status!=='ready'||report.source_sha256!==entry.sha256||!Number.isInteger(report.state_revision)||
       report.visual_review!=='not_run_user_paused'||report.image_generation!=='disabled_by_scope'||report.blocking_errors?.length||
       PROOF_CHECKS.some(key=>report.checks?.[key]!=='passed')||!report.artifact_sha256||
       Object.keys(report.artifact_sha256).some(key=>!report.artifacts?.[key])) throw new Error('证明内容与导出记录不一致');
  } catch(error) {throw apiError('DELIVERY_BLOCKED','历史导出独立交付证明无效：'+error.message);}
}
export async function exportProject(id,{note=''}={}) {
  return withProjectLock(id,async()=>{
    const {meta}=await loadProject(id);
    if(!meta.version || !meta.source_name) throw apiError('INVALID_OPERATION','尚无可导出版本');
    const src=path.join(projectDir(id),'versions',meta.source_name),sha=await sha256File(src);
    if(sha!==meta.source_sha256) throw apiError('SOURCE_HASH_MISMATCH','当前文件发生变化');
    const delivery=await readJson(path.join(projectDir(id),'delivery-check-'+meta.version+'.json'),null);
    const report=await readJson(path.join(projectDir(id),meta.latest_report||'report-'+meta.version+'.json'),null);
    const composed=Boolean(meta.component_state_path||report?.phase==='compose'&&delivery?.source_sha256===sha);
    if(composed) {
      await assertDeliveryReady(id,{version:meta.version,source_sha256:sha,state_revision:delivery?.state_revision});
    }
    const fillCheck=!composed&&report?.phase==='template_fill'?await assertTemplateFillReady(id,{version:meta.version,source_sha256:sha}):null;
    let document_state=composed||fillCheck?'ready':'draft';
    if(!composed&&report?.phase==='final'&&report.approved_sample?.sha256===sha) {
      const review=await currentDraftReview(id,meta);
      if(!requirementVerificationIssue(review,{...report.approved_sample.requirement_review,version:meta.version,sha256:sha})) document_state='final';
    }
    const list=await exportsRegistry(id);
    const previous=list.find((e)=>e.version===meta.version && e.sha256===sha && e.document_state===document_state &&
      e.kind===(composed?'compose':'template_fill')&&(!(composed||fillCheck)||Boolean(e.proof_file&&e.proof_sha256))&&fs.existsSync(path.join(config().dataDir,e.file)));
    let entry=previous;
    if(previous) await verifiedExportProof(id,previous);
    if(!entry) {
      const exportId='exp-'+randomUUID(),downloadName=(meta.title || id).replace(/[\\/:*?"<>|]+/g,'_').slice(0,60)+(document_state==='draft'?'_草稿_':'_')+meta.version+'.pptx';
      const rel=path.join('exports',id,exportId,downloadName),target=path.join(config().dataDir,rel);
      await fsp.mkdir(path.dirname(target),{recursive:true});
      try {
        await fsp.copyFile(src,target,fs.constants.COPYFILE_EXCL);
        if(await sha256File(target)!==sha) throw apiError('SOURCE_HASH_MISMATCH','导出副本与已检查版本不一致');
        entry={id:exportId,kind:composed?'compose':'template_fill',version:meta.version,file:rel,download_name:downloadName,
          sha256:sha,document_state,note,exported_at:nowIso()};
        if(composed||fillCheck) {
          const checked=composed?delivery:fillCheck;
          const proof={schema_version:1,kind:composed?'compose':'template_fill',project_id:id,export_id:exportId,version:meta.version,
            source_sha256:sha,report_digest:stableHash(checked),delivery:checked};
          entry.proof_file=path.join(path.dirname(rel),'delivery-proof.json');
          const proofPath=path.join(config().dataDir,entry.proof_file);
          await writeJson(proofPath,proof);
          entry.proof_sha256=await sha256File(proofPath);
          await verifiedExportProof(id,entry);
        }
      } catch(error) {await fsp.rm(path.dirname(target),{recursive:true,force:true});throw error;}
      list.push(entry); await writeJson(path.join(projectDir(id),'exports.json'),list);
    }
    if(document_state==='final') await updateProjectMeta(id,{status:'archived',archived_at:nowIso(),last_export:entry.id,next_action:'重新打开继续制作'});
    else if(document_state==='ready') await updateProjectMeta(id,{last_export:entry.id,document_state:'ready',next_action:'文件检查通过，未进行视觉评审'});
    else await updateProjectMeta(id,{last_draft_export:entry.id,next_action:'草稿已下载，待核实与确认定稿'});
    invalidateIndex(); return {...entry,document_state,archived:document_state==='final',deduplicated:!!previous};
  });
}
export async function downloadVersion(id,{version,export_id}={}) {
  if(export_id) {
    const entry=(await exportsRegistry(id)).find((e)=>e.id===export_id);
    if(!entry) throw apiError('SOURCE_NOT_FOUND','导出记录不存在');
    const file=path.join(config().dataDir,entry.file);
    if(!fs.existsSync(file) || await sha256File(file)!==entry.sha256) throw apiError('SOURCE_NOT_FOUND','导出文件缺失或已变化');
    await verifiedExportProof(id,entry);
    return {path:file,name:entry.download_name};
  }
  const {meta}=await loadProject(id);
  const label=version || meta.version;
  if(!/^v\d{4,}$/.test(label || '')) throw apiError('INVALID_OPERATION','没有有效的版本');
  const file=path.join(projectDir(id),'versions','revision-'+String(Number(label.slice(1))).padStart(3,'0')+'.pptx');
  if(!fs.existsSync(file)) throw apiError('SOURCE_NOT_FOUND','版本文件不存在');
  if(label===meta.version&&await sha256File(file)!==meta.source_sha256) throw apiError('SOURCE_HASH_MISMATCH','当前草稿文件已变化');
  const report=await readJson(path.join(projectDir(id),'report-'+label+'.json'),null);
  const delivery=await readJson(path.join(projectDir(id),'delivery-check-'+label+'.json'),null);
  if(report?.phase==='compose'||delivery?.profile==='non_visual_v1'||fs.existsSync(file.replace(/\.pptx$/i,'.state.json'))||
     (label===meta.version&&meta.component_state_path)) {
    await assertDeliveryReady(id,{version:label,source_sha256:await sha256File(file),state_revision:delivery?.state_revision});
  }
  if(report?.phase==='template_fill')await assertTemplateFillReady(id,{version:label,source_sha256:await sha256File(file)});
  const suffix=delivery?.status==='ready'||report?.phase==='final'&&report.approved_sample?'_':'_草稿_';
  return {path:file,name:(meta.title || id).replace(/[\\/:*?"<>|]+/g,'_')+suffix+label+'.pptx'};
}
export async function orphanExports() {
  const root=path.join(config().dataDir,'exports'); if(!fs.existsSync(root)) return [];
  const out=[];
  for(const id of await fsp.readdir(root)) if(!fs.existsSync(path.join(projectDir(id),'project.json'))) out.push({project_id:id,file:path.join('exports',id)});
  return out;
}
export async function deleteOrphanExport(id) {
  if(!(await orphanExports()).some((e)=>e.project_id===id)) throw apiError('INVALID_OPERATION','仅能清理清单中的孤立导出');
  await fsp.rm(path.join(config().dataDir,'exports',id),{recursive:true,force:true}); return {deleted:id};
}
