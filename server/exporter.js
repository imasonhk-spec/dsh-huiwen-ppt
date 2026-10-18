import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, sha256File, nowIso, apiError } from './util.js';
import { withProjectLock } from './workflow.js';
import { invalidateIndex } from './index-builder.js';
export async function exportsRegistry(id) { return readJson(path.join(projectDir(id),'exports.json'),[]); }
export async function exportProject(id,{note=''}={}) {
  return withProjectLock(id,async()=>{
    const {meta}=await loadProject(id);
    if(!meta.version || !meta.source_name) throw apiError('INVALID_OPERATION','尚无可导出版本');
    const src=path.join(projectDir(id),'versions',meta.source_name),sha=await sha256File(src);
    if(sha!==meta.source_sha256) throw apiError('SOURCE_HASH_MISMATCH','当前文件发生变化');
    const list=await exportsRegistry(id);
    const previous=list.find((e)=>e.version===meta.version && e.sha256===sha && fs.existsSync(path.join(config().dataDir,e.file)));
    let entry=previous;
    if(!entry) {
      const exportId='exp-'+randomUUID(),downloadName=(meta.title || id).replace(/[\\/:*?"<>|]+/g,'_').slice(0,60)+'_'+meta.version+'.pptx';
      const rel=path.join('exports',id,exportId,downloadName),target=path.join(config().dataDir,rel);
      await fsp.mkdir(path.dirname(target),{recursive:true}); await fsp.copyFile(src,target,fs.constants.COPYFILE_EXCL);
      entry={id:exportId,version:meta.version,file:rel,download_name:downloadName,sha256:sha,note,exported_at:nowIso()};
      list.push(entry); await writeJson(path.join(projectDir(id),'exports.json'),list);
    }
    await updateProjectMeta(id,{status:'archived',archived_at:nowIso(),last_export:entry.id,next_action:'重新打开继续制作'});
    invalidateIndex(); return {...entry,archived:true,deduplicated:!!previous};
  });
}
export async function downloadVersion(id,{version,export_id}={}) {
  const {meta}=await loadProject(id);
  if(export_id) {
    const entry=(await exportsRegistry(id)).find((e)=>e.id===export_id);
    if(!entry) throw apiError('SOURCE_NOT_FOUND','导出记录不存在');
    const file=path.join(config().dataDir,entry.file);
    if(!fs.existsSync(file) || await sha256File(file)!==entry.sha256) throw apiError('SOURCE_NOT_FOUND','导出文件缺失或已变化');
    return {path:file,name:entry.download_name};
  }
  const label=version || meta.version;
  if(!/^v\d{4,}$/.test(label || '')) throw apiError('INVALID_OPERATION','没有有效的版本');
  const file=path.join(projectDir(id),'versions','revision-'+String(Number(label.slice(1))).padStart(3,'0')+'.pptx');
  if(!fs.existsSync(file)) throw apiError('SOURCE_NOT_FOUND','版本文件不存在');
  return {path:file,name:(meta.title || id).replace(/[\\/:*?"<>|]+/g,'_')+'_'+label+'.pptx'};
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
