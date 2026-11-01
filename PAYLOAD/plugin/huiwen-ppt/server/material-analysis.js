import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from './projects.js';
import { listContentMaterials } from './materials.js';
import { readJson, writeJson, stableHash } from './util.js';
import { chatJson } from './llm.js';
import { listMaterialFacts } from './knowledge.js';
import { loadProject } from './projects.js';

export function sourceEvidence(text, offset=0) {
  return [...text.matchAll(/[^\n]+/g)].filter((line)=>line[0].trim()).map((line)=>({
    id:'E'+(offset+line.index+1), locator:'字符 '+(offset+line.index+1)+'–'+(offset+line.index+line[0].length), quote:line[0],
  }));
}

export async function materialDigest(projectId, model) {
  const result = [];
  const materials=await listContentMaterials(projectId);
  for (const m of materials) {
    if (!m.text_extracted || m.extraction_status === 'partial') throw Object.assign(new Error('材料「'+m.name+'」尚未完整提取：'+(m.extraction_error || m.extraction_status || '未知状态')), { code: 'MATERIAL_ANALYSIS_FAILED' });
    const file = path.join(projectDir(projectId), m.file);
    const text = await fsp.readFile(file + '.extract.txt','utf8');
    if (text.length <= 12000) { result.push({ name:m.name, sha256:m.sha256, digest:text, coverage:'complete' }); continue; }
    if (!model?.online) throw Object.assign(new Error('长材料分析需要可用模型'), { code:'LLM_UNAVAILABLE' });
    const cacheFile = file + '.summary-' + stableHash({ sha:m.sha256,extract:stableHash(text),model:model.id,tag:model.tag,version:3 }) + '.json';
    const chunks=[];
    for (let i=0;i<text.length;i+=6000) chunks.push({ locator:'字符 '+(i+1)+'–'+Math.min(i+6000,text.length), evidence:sourceEvidence(text.slice(i,i+6000),i) });
    let cached = await readJson(cacheFile,null);
    if (!cached || !Array.isArray(cached.chunks) || cached.chunks.length>chunks.length || cached.chunks.some((saved,i)=>{
      const refs=new Map(chunks[i].evidence.map((ref)=>[ref.id,ref]));
      return !saved || typeof saved.summary!=='string' || !saved.summary.trim() || saved.locator!==chunks[i].locator || !Array.isArray(saved.evidence) || !saved.evidence.length || saved.evidence.some((ref)=>!ref || !refs.has(ref.id) || refs.get(ref.id).quote!==ref.quote || refs.get(ref.id).locator!==ref.locator) || JSON.stringify(saved.quotes)!==JSON.stringify(saved.evidence.map((ref)=>ref.quote));
    })) cached={coverage:'partial',chunks:[],numeric_evidence:text.split('\n').filter((line)=>/\d/.test(line)),model:model.id,source_sha256:m.sha256};
    for (let i=cached.chunks.length;i<chunks.length;i++) {
      const chunk=chunks[i], refs=new Map(chunk.evidence.map((ref)=>[ref.id,ref]));
      let parsed;
      try {
        parsed=await chatJson({model,timeoutMs:600000,system:'分析 PPT 材料的原文证据表。保留全部关键事实、数字、单位、结论和来源，summary 用400–800字概括。证据由程序从原文提取：只选择表中实际存在的 id，不要抄写、改写或拼接原文。只输出 JSON {"summary":"摘要","evidence_ids":["证据表中的id"]}，选择3–6个最重要的证据编号；不足3个时选择全部。',messages:[{role:'user',content:JSON.stringify(chunk.evidence)}]},(value)=>{
          if (typeof value.summary!=='string' || !value.summary.trim()) return 'summary 必须为非空文本';
          if (!Array.isArray(value.evidence_ids) || !value.evidence_ids.length || value.evidence_ids.some((id)=>typeof id!=='string' || !refs.has(id))) return 'evidence_ids 必须选择原文证据表中存在的编号';
        });
      } catch(e) {
        if(e.code!=='LLM_BAD_OUTPUT') throw e;
        throw Object.assign(new Error('材料「'+m.name+'」（'+chunk.locator+'）摘要校验失败：'+e.message),{code:'MATERIAL_SUMMARY_INVALID'});
      }
      const evidence=[...new Set(parsed.evidence_ids)].map((id)=>refs.get(id));
      cached.chunks.push({locator:chunk.locator,summary:parsed.summary,evidence,quotes:evidence.map((ref)=>ref.quote)});
      cached.coverage='partial';
      await writeJson(cacheFile,cached);
    }
    if(cached.coverage!=='complete') {
      cached.coverage='complete';
      await writeJson(cacheFile,cached);
    }
    result.push({ name:m.name, sha256:m.sha256, digest:JSON.stringify(cached), coverage:cached.coverage });
  }
  const {meta}=await loadProject(projectId);
  for(const fact of await listMaterialFacts(projectId)) if(fact.status==='confirmed' && (fact.epoch||0)===(meta.epoch||0) && (!fact.source_material_id || materials.some((m)=>m.id===fact.source_material_id&&m.sha256===fact.source_sha256))) result.push({name:fact.source_name,sha256:fact.source_sha256,digest:fact.text,locator:fact.locator,coverage:'confirmed-fact'});
  return result;
}
