import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectDir, loadProject } from './projects.js';
import { readJson, writeJson, nowIso, apiError } from './util.js';
import { currentVersion, reviseFromInstruction } from './revise.js';
import { withProjectLock } from './workflow.js';

export async function annotations(id,version) {
  const all=await readJson(path.join(projectDir(id),'annotations.json'),[]);
  return version ? all.filter((a)=>a.version===version) : all;
}
export async function addAnnotation(id,body) {
  return withProjectLock(id,async()=>{
    const cur=await currentVersion(id);
    if(body.version!==cur.label || body.sha256!==cur.sha256) throw apiError('ANNOTATION_VERSION_MISMATCH','版本已变化，重新加载后再批注');
    const insp=await readJson(path.join(projectDir(id),'inspection-'+cur.label+'.json'),null);
    if(!Number.isInteger(body.slide)||!insp.slides[body.slide-1]||!String(body.text||'').trim()) throw apiError('INVALID_OPERATION','批注需要有效页码和内容');
    if(body.region && ['x','y','width','height'].some((k)=>!Number.isFinite(body.region[k]))) throw apiError('INVALID_OPERATION','批注框坐标无效');
    const entry={id:'annotation-'+randomUUID(),version:cur.label,sha256:cur.sha256,slide:body.slide,text:String(body.text),type:body.type||'文字',region:body.region||null,status:'pending',created_at:nowIso()};
    const all=await annotations(id);all.push(entry);await writeJson(path.join(projectDir(id),'annotations.json'),all);return entry;
  });
}
export async function deleteAnnotation(id,annotationId) {
  return withProjectLock(id,async()=>{const all=await annotations(id);if(!all.some((a)=>a.id===annotationId)) throw apiError('SOURCE_NOT_FOUND','批注不存在');await writeJson(path.join(projectDir(id),'annotations.json'),all.filter((a)=>a.id!==annotationId));return {deleted:annotationId};});
}
export async function submitAnnotations(id,body) {
  const cur=await currentVersion(id),all=await annotations(id);
  const selected=all.filter((a)=>body.ids?.includes(a.id));
  if(!selected.length || selected.some((a)=>a.version!==cur.label||a.sha256!==cur.sha256||a.status!=='pending')) throw apiError('ANNOTATION_VERSION_MISMATCH','请选择当前版本尚未应用的批注');
  const result=await reviseFromInstruction(id,selected.map((a)=>'第'+a.slide+'页：'+a.text).join('\n'),body.model_id,{version:cur.label,expected_sha256:cur.sha256});
  if(!result.applied) return result;
  await withProjectLock(id,async()=>{const latest=await annotations(id);for(const a of latest) if(selected.some((s)=>s.id===a.id)){a.status='applied';a.applied_version=result.version;a.applied_sha256=result.sha256;}await writeJson(path.join(projectDir(id),'annotations.json'),latest);});
  return result;
}
export async function compareVersions(id,left,right) {
  await loadProject(id);
  if(!/^v\d{4,}$/.test(left||'')||!/^v\d{4,}$/.test(right||'')) throw apiError('INVALID_OPERATION','比较需要两个有效版本');
  const dir=projectDir(id),a=await readJson(path.join(dir,'inspection-'+left+'.json'),null),b=await readJson(path.join(dir,'inspection-'+right+'.json'),null);
  if(!a||!b) throw apiError('SOURCE_NOT_FOUND','版本巡检文件缺失');
  const differences=[];
  for(let i=0;i<Math.max(a.slides.length,b.slides.length);i++) {
    const aa=new Map((a.slides[i]?.elements||[]).map((e)=>[e.shape_id,e])),bb=new Map((b.slides[i]?.elements||[]).map((e)=>[e.shape_id,e]));
    for(const shape_id of new Set([...aa.keys(),...bb.keys()])) {
      const before=aa.get(shape_id),after=bb.get(shape_id);
      if(!before||!after||before.text!==after.text||JSON.stringify(before.position)!==JSON.stringify(after.position)||before.rotation!==after.rotation) differences.push({slide:i+1,shape_id,before:before||null,after:after||null});
    }
  }
  return {left:{version:left,sha256:a.sha256,report:await readJson(path.join(dir,'report-'+left+'.json'),null)},right:{version:right,sha256:b.sha256,report:await readJson(path.join(dir,'report-'+right+'.json'),null)},differences};
}
