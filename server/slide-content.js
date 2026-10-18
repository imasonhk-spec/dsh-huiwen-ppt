import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectDir, loadProject } from './projects.js';
import { loadBrief, briefSummary } from './brief.js';
import { listContentMaterials } from './materials.js';
import { sourceEvidence } from './material-analysis.js';
import { resolveModel, chatJson } from './llm.js';
import { readJson, writeJson, stableHash, apiError } from './util.js';
import { inputFingerprint } from './dependencies.js';
import { checkCancelled } from './workflow.js';
import { listMaterialFacts } from './knowledge.js';

function titleShape(slide) {
  const shapes=(slide.elements || []).filter(e=>e.kind==='sp'&&e.editable_text);
  return shapes.find(e=>/^(标题|title)$/i.test(e.name || '')) || shapes.find(e=>/标题|title/i.test(e.name || '')) || shapes[0];
}

export function textBoxSize(slot) {
  const inset=slot.text_insets;
  return {width:(slot.position.width-(inset?.left ?? 9.6)-(inset?.right ?? 9.6))*0.75,
    height:(slot.position.height-(inset?.top ?? 4.8)-(inset?.bottom ?? 4.8))*0.75};
}

export function contentSlots(slide) {
  const slots=[],title=titleShape(slide);
  for(const e of slide.elements || []) {
    if(e.hidden || e.grouped || e.occluded_by_full_page_picture) continue;
    if(e.kind==='sp' && e.editable_text && e!==title && !/^(页码|序号|日期|编号|模板编号|版本|logo|version)/i.test(e.name || '')) {
      slots.push({id:e.shape_id,name:e.name || '正文',kind:'sp',position:e.position,text_insets:e.text_insets});
    } else if(e.kind==='table') {
      for(let row=0;row<e.cells.length;row++) for(let column=0;column<e.cells[row].length;column++) {
        slots.push({id:e.shape_id+':'+row+':'+column,name:(row===0?'表头':'表格正文')+' '+row+'/'+column,kind:'table',shape_id:e.shape_id,row,column,
          position:{...e.position,width:e.position.width/e.cells[row].length,height:e.position.height/e.cells.length}});
      }
    } else if(e.kind==='chart') slots.push({id:e.shape_id,name:'数据与统计口径（无原始序列时用完整文字说明）',kind:'chart',position:e.position});
  }
  for(const s of slots) {
    // shortcut: conservative 14pt capacity, revisit with font metrics if templates need richer typography.
    const {width,height}=textBoxSize(s);
    s.min_font=Math.min(14,Math.max(8,Math.floor(height/1.4)));
    const cols=Math.floor(width/s.min_font),rows=Math.floor(height/(s.min_font*1.4));
    if(cols<1 || rows<1) throw apiError('UNSUPPORTED_OBJECT','模板字段 '+s.id+'（'+s.name+'）无法容纳可读文字，请选择更大版式');
    s.max_lines=rows;
    // Keep the writing margin in target_chars; native geometry is the hard limit.
    s.max_chars=Math.max(1,Math.min(s.kind==='table'?40:260,cols*rows));
  }
  if(!slots.length) throw apiError('UNSUPPORTED_OBJECT','模板没有可填充正文的字段');
  return slots;
}

function fieldIssue(slot,text,checkCapacity=true) {
  if(typeof text!=='string' || !text.trim()) return '缺少非空字段 '+slot.id+'（'+slot.name+'）';
  const issues=[];
    // Text boxes fit displayed width, not raw length (English is narrower than CJK).
    if([...text].length>slot.max_chars && ((checkCapacity && slot.kind==='table') || [...text].length>slot.max_chars*4)) issues.push('字段 '+slot.id+' 当前'+[...text].length+'字，超过'+slot.max_chars+'字预算，请压缩或将细节移入其他正文区');
    const {width,height}=textBoxSize(slot);
    const minFont=slot.min_font || 14;
    const rows=text.split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].reduce((n,ch)=>n+(/[^\u0000-\u007f]/.test(ch)?1:0.65),0)*minFont/width)),0);
    if(checkCapacity && rows*minFont*1.4>height) issues.push('字段 '+slot.id+' 超过可读容量（含自动折行）：当前 '+rows+' 行，最多 '+Math.floor(height/(minFont*1.4))+' 行；请精简文字、减少换行或将长名称移到其他正文区');
  return issues.join('；') || undefined;
}

function minimumContentChars(page,slots) {
  return /封面|收尾/.test(page.relation)?40:Math.min(180,Math.floor(slots.reduce((n,s)=>n+s.max_chars,0)*0.55));
}

function requiredNames(page,sources) {
  const original=sources.map(s=>s.quote).join('\n').toLowerCase();
  return [...new Set(((page.key_points || []).join('\n').match(/[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*/g) || []).filter(name=>name.length>=3 && original.includes(name.toLowerCase())))];
}

function missingNameIssue(content,page,sources) {
  const text=[page.title,...content.fields.map(f=>f.text)].join('\n').toLowerCase();
  const missing=requiredNames(page,sources).filter(name=>!text.includes(name.toLowerCase()));
  if(missing.length) return '正文遗漏原文与大纲中的技术名称：'+missing.join('、')+'；请将完整名称移入有余量的正文区，不能通过删除技术细节压缩';
}

export function contentIssue(value,page,slots,sources,checkCapacity=true,checkRichness=checkCapacity) {
  if(!Array.isArray(value.fields) || value.fields.length!==slots.length || new Set(value.fields.map(f=>f?.id)).size!==slots.length) return 'fields 必须完整且不重复地包含全部字段编号';
  const issues=[];
  for(const slot of slots) {
    const field=value.fields.find(f=>f?.id===slot.id);
    const issue=fieldIssue(slot,field?.text,checkCapacity);
    if(issue) issues.push(issue);
    if(!field || typeof field.text!=='string') continue;
    if(page.purpose && field.text.includes(page.purpose)) return 'purpose 是规划目的，不能直接作为页面正文';
  }
  if(issues.length) return issues.join('；');
  const text=value.fields.map(f=>f.text).join('\n');
  const minimum=minimumContentChars(page,slots);
  const chars=text.replace(/\s/g,'').length;
  if(checkRichness && chars<minimum) return '正文过于简略，当前 '+chars+' 字，需要至少 '+minimum+' 字；在有剩余容量的正文区补充输入、处理步骤、输出、依据与条件，不能原样返回大纲短句';
  if(!Array.isArray(value.covered_points) || (page.key_points || []).some((_,i)=>!value.covered_points.includes(i+1))) return 'covered_points 必须覆盖全部大纲要点编号';
  if(!Array.isArray(value.evidence_ids) || (sources.length && !value.evidence_ids.length) || value.evidence_ids.some(id=>!sources.some(s=>s.id===id))) return 'evidence_ids 必须选择提供的原文编号；无材料时使用空数组';
  const original=sources.filter(s=>value.evidence_ids.includes(s.id)).map(s=>s.quote).join('\n');
  if(claimsMeasured(text) && !claimsMeasured(original)) return '原文没有实测/已验证证据，必须保留初步测算、预计或计划等事实状态';
  if(checkRichness) return missingNameIssue(value,page,sources);
}

export async function fitContentFields(model,content,page,slots,sources) {
  // Refilled content must pass through the same compression as the initial draft.
  for(let round=0;round<2;round++) {
    let redistributionIssue;
    const oversized=slots.filter(slot=>fieldIssue(slot,content.fields.find(f=>f.id===slot.id)?.text));
    for(let i=0;i<oversized.length;i+=4) {
      checkCancelled();
      const batch=oversized.slice(i,i+4);
      const fields=batch.map(s=>{
        const text=content.fields.find(f=>f.id===s.id).text,target=Math.max(1,Math.floor(s.max_chars*0.85));
        return {id:s.id,text,max_chars:s.max_chars,max_lines:s.max_lines,target_chars:target};
      });
      let fixed;
      try {
        fixed=await chatJson({model,timeoutMs:600000,system:'将PPT字段精简为适合文本框的短句。尽量保留信息，只精简超出的部分，保留实体、数字、预计等事实限定和关键机制；标题只写短标签，不堆砌说明。每个字段控制在target_chars左右，绝不能超过max_chars，不要换行。只输出JSON {"fields":[{"id":"原编号","text":"精简后的文字"}]}，完整覆盖本次全部字段。',messages:[{role:'user',content:JSON.stringify({fields})}]},v=>{
          if(!Array.isArray(v.fields) || v.fields.length!==batch.length || new Set(v.fields.map(f=>f?.id)).size!==batch.length) return 'fields 必须完整且不重复地包含本次全部字段';
          return batch.map(s=>fieldIssue(s,v.fields.find(f=>f?.id===s.id)?.text)).filter(Boolean).join('；') || undefined;
        });
      } catch(e) {
        if(e.code!=='LLM_BAD_OUTPUT' || round===1) throw e;
        redistributionIssue=e.message;
        break;
      }
      for(const field of fixed.fields) content.fields.find(f=>f.id===field.id).text=field.text;
    }
    redistributionIssue ||= missingNameIssue(content,page,sources);
    const chars=content.fields.map(f=>f.text).join('').replace(/\s/g,'').length;
    const gap=minimumContentChars(page,slots)-chars;
    if(!redistributionIssue && gap>0) {
      const available=slots.filter(s=>s.max_chars>=40 && !/标题|表头|标签/.test(s.name) && !(s.kind==='table' && s.column===0)).map(s=>({...s,current_text:content.fields.find(f=>f.id===s.id).text})).map(s=>({...s,room:s.max_chars-s.current_text.replace(/\s/g,'').length})).sort((a,b)=>b.room-a.room);
      const slot=available.find(s=>s.room>=gap);
      if(slot) {
        const minimum=slot.current_text.replace(/\s/g,'').length+gap;
        const filled=await chatJson({model,timeoutMs:600000,system:'仅扩写指定的一个PPT正文区，其他字段已完成。保留当前正文的事实、数字、预计/计划限定和完整技术名称，依据原文补充输入、处理机制、输出与条件。该字段至少写到 min_chars 字（不含空白），尽量达到 target_chars，不能原样返回短正文，也不能重复句子凑字数。遵守 max_lines，不超出可读容量。只输出 JSON {"fields":[{"id":"指定编号","text":"完整扩写后的正文"}]}。',messages:[{role:'user',content:JSON.stringify({page,fields:[{id:slot.id,name:slot.name,current_text:slot.current_text,min_chars:minimum,target_chars:Math.min(slot.max_chars,minimum+8),max_chars:slot.max_chars,max_lines:slot.max_lines}],sources})}]},v=>{
          if(!Array.isArray(v.fields) || v.fields.length!==1 || v.fields[0]?.id!==slot.id || typeof v.fields[0].text!=='string') return '只返回指定的一个完整正文字段 '+slot.id;
          if(v.fields[0].text.replace(/\s/g,'').length<=slot.current_text.replace(/\s/g,'').length) return '字段 '+slot.id+' 尚未增加正文，需要至少 '+minimum+' 字，请补充具体机制、依据与输出，不能原样返回';
          const candidate={...content,fields:content.fields.map(f=>f.id===slot.id?v.fields[0]:f)};
          return contentIssue(candidate,page,slots,sources,true,false) || missingNameIssue(candidate,page,sources);
        });
        content.fields.find(f=>f.id===slot.id).text=filled.fields[0].text;
        if(content.fields.map(f=>f.text).join('').replace(/\s/g,'').length>=minimumContentChars(page,slots)) break;
        continue;
      }
    }
    if(round===1 || (!redistributionIssue && gap<=0)) break;
    content=await chatJson({model,timeoutMs:600000,system:[
        '当前页面需调整内容分配或补足正文。依据提供的原文及当前正文，将长模型名、实体、数字及完整机制移到有剩余容量的正文区，短字段只保留中文职责或标签；issue 指出的溢出字段必须改写，完整英文名称移到长正文区，不能原样返回。不能删除关键事实。补充输入、处理机制、输出、条件与依据。',
        'required_names 中的完整名称必须逐字保留，并分配到 name_fields 指定的宽正文区，结合原文解释机制；其余窄字段只写中文动作/职责标签，不填写英文模型全称。不能将完整名称塞回原来的窄框，也不能只保留简称。',
        '整页至少达到page_min_chars字（不含空白），各字段尽量写到target_chars，绝不能原样返回不足字数的当前正文。每个字段不得超过max_chars和max_lines（含自动折行）。不要删字段或大纲要点，不增加无依据事实，保留预计、初步测算、计划等事实限定。',
        '只输出JSON {"fields":[{"id":"原编号","text":"完整正文"}],"evidence_ids":["原文编号"],"covered_points":[1,2]}，覆盖全部字段和大纲要点。',
      ].join('\n'),messages:[{role:'user',content:JSON.stringify({page,page_min_chars:minimumContentChars(page,slots),required_names:requiredNames(page,sources),name_fields:[...slots].sort((a,b)=>b.max_chars-a.max_chars).slice(0,2).map(s=>s.id),redistribution_issue:redistributionIssue,fields:slots.map(s=>({id:s.id,name:s.name,max_chars:s.max_chars,max_lines:s.max_lines,target_chars:Math.max(1,Math.floor(s.max_chars*0.8)),current_text:content.fields.find(f=>f.id===s.id).text,issue:fieldIssue(s,content.fields.find(f=>f.id===s.id).text)})),sources})}]},v=>contentIssue(v,page,slots,sources,false,true));
  }
  const issue=contentIssue(content,page,slots,sources) || missingNameIssue(content,page,sources);
  if(issue) throw apiError('LLM_BAD_OUTPUT',issue);
  return content;
}

export function claimsMeasured(text) {
  const affirmative=text.replace(/(?:并非|不是|非|尚未|未经|未|没有|缺少|待|需)(?:大规模|正式|完成|进行|进一步)?的?(?:实测|实证|已验证)/g,'');
  return /实测|实证|已验证/.test(affirmative);
}

async function originalSources(id) {
  const refs=[];
  const materials=await listContentMaterials(id);
  for(const material of materials) {
    if(!material.text_extracted || material.extraction_status==='partial') throw apiError('MATERIAL_ANALYSIS_FAILED','材料尚未完整提取：'+material.name);
    const text=await fsp.readFile(path.join(projectDir(id),material.file)+'.extract.txt','utf8');
    refs.push(...sourceEvidence(text).map(s=>({...s,id:material.id+':'+s.id,source_name:material.name,source_sha256:material.sha256})));
  }
  const {meta}=await loadProject(id);
  for(const fact of await listMaterialFacts(id)) if(fact.status==='confirmed' && (fact.epoch || 0)===(meta.epoch || 0) && (!fact.source_material_id || materials.some(m=>m.id===fact.source_material_id && m.sha256===fact.source_sha256))) {
    refs.push({id:'confirmed:'+fact.id,quote:fact.text,source_name:fact.source_name,source_sha256:fact.source_sha256,locator:fact.locator});
  }
  const brief=await loadBrief(id);
  if(brief) refs.push(...sourceEvidence([brief.title,brief.key_message,brief.notes].filter(Boolean).join('\n')).map(s=>({...s,id:'brief:'+s.id,source_name:'用户需求',source_sha256:stableHash(briefSummary(brief))})));
  return refs;
}

function pageSources(page,refs) {
  const query=[page.title,...page.key_points].join('');
  const terms=new Set(query.match(/[A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2}/g) || []);
  for(let i=0;i<query.length-1;i++) if(/[\u4e00-\u9fff]{2}/.test(query.slice(i,i+2))) terms.add(query.slice(i,i+2));
  const ranked=refs.map((s,i)=>({i,score:[...terms].reduce((n,t)=>n+(s.quote.includes(t)?t.length:0),0)})).sort((a,b)=>b.score-a.score||a.i-b.i);
  const selected=new Set();
  for(const {i} of ranked.slice(0,24)) for(const n of [i-1,i,i+1]) if(refs[n]?.source_name===refs[i].source_name) selected.add(n);
  let size=0;
  return [...selected].sort((a,b)=>a-b).map(i=>refs[i]).filter(s=>{size+=s.quote.length;return size<=12000;});
}

export async function generateSlideContent(id,page,slide) {
  checkCancelled();
  const {meta}=await loadProject(id),model=await resolveModel(meta.dialogue_model);
  if(!model.online) throw apiError('LLM_UNAVAILABLE','逐页正文生成需要可用模型：'+(model.reason || model.label));
  const slots=contentSlots(slide),allSources=await originalSources(id),sources=pageSources(page,allSources);
  const fingerprint=stableHash({schema:2,input:await inputFingerprint(id),page,slots,sources:allSources.filter(s=>!s.id.startsWith('brief:')),model:{id:model.id,tag:model.tag}});
  const file=path.join(projectDir(id),'slide-content.json');
  const savedCache=await readJson(file,null);
  const cache=Array.isArray(savedCache?.pages)?savedCache:{pages:[]};
  const saved=cache.pages?.find(p=>p.n===page.n && p.fingerprint===fingerprint);
  if(saved && !contentIssue(saved.content,page,slots,sources)) return saved.content;
  let content=await chatJson({model,timeoutMs:600000,system:[
    '你是 PPT 正文作者，必须把大纲展开为可直接展示的完整内容，而不是规划说明。',
    '原文是事实依据，大纲仅是结构。如果两者冲突，以原文为准。不得把预计、初步测算、试点或计划写成实测、已实施或已验证，不虚构数字、案例、评分或完成状态。',
    '按模板字段组织正文：短字段写分区标题/标签，长字段展开输入、步骤、技术机制、输出、证据、使用条件；表格逐格填写，单一字段不要塞全部要点。',
    'required_names 中的完整名称分配到 name_fields 指定的宽正文区，结合原文介绍机制。max_chars 不足16的窄字段只写中文职责/动作标签，不能塞入完整英文模型名称再靠删除名称压缩。',
    '通常内容页写220–400字，封面/收尾简洁。优先控制在每个字段target_chars左右，max_chars 是硬上限，长英文和符号也计入字数；换行会消耗容量，只在长正文区分段。详细信息只来自原文，无依据的建议必须写明建议/待验证。',
    '输出 JSON {"fields":[{"id":"字段编号","text":"完整正文"}],"evidence_ids":["原文编号"],"covered_points":[1,2]}。fields必须包含每个字段且都非空，covered_points列出全部已融入正文的大纲要点编号。只选择原文中存在的evidence_ids，选择3–6个最相关编号，不抄写原文；原文不足3条时选择全部，无材料时空数组。',
  ].join('\n'),messages:[{role:'user',content:JSON.stringify({requirements:briefSummary(await loadBrief(id)),page,page_min_chars:minimumContentChars(page,slots),required_names:requiredNames(page,sources),name_fields:[...slots].sort((a,b)=>b.max_chars-a.max_chars).slice(0,2).map(s=>s.id),fields:slots.map(({id,name,max_chars,max_lines})=>({id,name,max_chars,max_lines,target_chars:Math.max(1,Math.floor(max_chars*0.75))})),sources})}]},v=>contentIssue(v,page,slots,sources,false));
  content=await fitContentFields(model,content,page,slots,sources);
  checkCancelled();
  await writeJson(file,{schema:1,pages:[...(cache.pages || []).filter(p=>p.n!==page.n),{n:page.n,fingerprint,model:model.tag,content,sources:sources.filter(s=>content.evidence_ids.includes(s.id))}]});
  return content;
}

export function detailedOperations(page,slide,outIndex,content) {
  const slots=contentSlots(slide),ops=[],title=titleShape(slide);
  for(const e of slide.elements || []) if(e.kind==='sp' && e.editable_text) {
    const field=content.fields.find(f=>f.id===e.shape_id);
    const text=e===title?page.title:/^(页码|模板编号)/.test(e.name || '')?String(outIndex).padStart(2,'0'):/^序号/.test(e.name || '')?e.text:field?.text || '';
    ops.push({op:'set-text',slide:outIndex,shape_id:e.shape_id,text,min_font:slots.find(s=>s.id===e.shape_id)?.min_font});
  }
  for(const slot of slots) {
    const text=content.fields.find(f=>f.id===slot.id).text;
    if(slot.kind==='table') ops.push({op:'table-cell',slide:outIndex,shape_id:slot.shape_id,row:slot.row,column:slot.column,text,min_font:slot.min_font});
    if(slot.kind==='chart') {
      ops.push({op:'delete-shape',slide:outIndex,shape_id:slot.id});
      ops.push({op:'insert-text',slide:outIndex,text,...slot.position,min_font:slot.min_font});
    }
  }
  return ops;
}
