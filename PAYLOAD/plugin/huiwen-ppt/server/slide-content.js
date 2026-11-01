import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectDir, loadProject } from './projects.js';
import { loadBrief, briefSummary } from './brief.js';
import { listContentMaterials } from './materials.js';
import { sourceEvidence } from './material-analysis.js';
import { resolveModel, chatJson } from './llm.js';
import { readJson, writeJson, stableHash, apiError } from './util.js';
import { inputFingerprint, planFingerprint } from './dependencies.js';
import { checkCancelled, withPptOperation, requestPptCorrection } from './workflow.js';
import { reviewDraft, groundedText } from './quality.js';
import { listMaterialFacts } from './knowledge.js';

export function compositionTextSources(page) {
  const points=(page.key_points||[]).filter(text=>typeof text==='string');
  const sources={'': '',$title:page.title,$points:points.join('\n'),
    ...Object.fromEntries(points.map((text,index)=>['$point:'+(index+1),text]))};
  const numbers=[...new Set(points.flatMap(text=>text.match(/(?<![A-Za-z0-9_.])[-+]?\d+(?:\.\d+)?(?![A-Za-z0-9_.])/g)||[]))];
  numbers.forEach((text,index)=>{sources['$number:'+(index+1)]=text;});
  return sources;
}

export function resolveCompositionBindings(page,instances) {
  const sources=compositionTextSources(page);
  const resolve=value=>{
    if(typeof value==='string') {
      if(!Object.hasOwn(sources,value))throw apiError('INVALID_BINDING','布局文字必须选择本页来源引用：'+value);
      return sources[value];
    }
    if(Array.isArray(value))return value.map(resolve);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item)]));
    return value;
  };
  return instances.map(instance=>({...instance,bindings:resolve(instance.bindings)}));
}

function expandComponentBinding(page,value) {
  if(value==='')return value;
  const source=[page.title,...(page.key_points || [])].filter(text=>typeof text==='string');
  const parts=value.split(/(\$(?:title|point:[1-9]\d*)(?![A-Za-z0-9_:]))/g);
  let grounded=false;
  const expanded=parts.map(part=>{
    if(!part)return part;
    if(part==='$title') {grounded=true;return page.title;}
    const match=part.match(/^\$point:([1-9]\d*)$/);
    if(match) {
      const point=page.key_points?.[Number(match[1])-1];
      if(typeof point!=='string')throw new Error('无效的本页来源编号：'+part);
      grounded=true;
      return point;
    }
    const fragments=part.split(/[\s，。；！？、：:,.!?;]+/u).filter(Boolean);
    if(fragments.some(fragment=>fragment.includes('$')||!source.some(text=>text.includes(fragment))))
      throw new Error('组件绑定必须使用本页来源引用、原文片段或空串：'+value);
    if(fragments.length)grounded=true;
    return part;
  });
  if(!grounded)throw new Error('组件绑定必须使用本页来源引用、原文片段或空串：'+value);
  return expanded.join('');
}

export function resolveComponentBindings(page,instances) {
  const resolve=value=>{
    if(typeof value==='string'&&value.includes('$'))return expandComponentBinding(page,value);
    if(Array.isArray(value))return value.map(resolve);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item)]));
    return value;
  };
  return instances.map(instance=>({...instance,bindings:resolve(instance.bindings)}));
}

export function componentBindingSourceIssue(page,instances) {
  const numbers=new Set((page.key_points || []).flatMap(point=>
    typeof point==='string'?(point.match(/(?<![A-Za-z0-9_.])[-+]?\d+(?:\.\d+)?(?![A-Za-z0-9_.])/g)||[]).map(Number):[]));
  let invalid;
  const visit=value=>{
    if(invalid)return;
    if(typeof value==='string') {
      try {expandComponentBinding(page,value);}catch {invalid=value;}
    } else if(typeof value==='number') {
      if(!Number.isFinite(value)||!numbers.has(value))invalid=String(value);
    } else if(Array.isArray(value)) value.forEach(visit);
    else if(value && typeof value==='object')Object.values(value).forEach(visit);
  };
  for(const instance of instances || [])visit(instance.bindings);
  return invalid ? '组件绑定必须使用本页来源引用、原文片段或空串：'+invalid : null;
}

const normalizeCompositionText=text=>String(text).replace(/[\s\p{P}\p{S}]/gu,'');
function compositionBindingStrings(instances) {
  const strings=[];
  const visit=value=>{if(typeof value==='string')strings.push(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
  for(const instance of instances || [])visit(instance.bindings);
  return strings;
}

function nativeTextField(key,native) {
  return {id:key,name:'原生正文',position:{width:native.width,height:native.height},
    text_insets:native.text_insets,min_font:native.font_pt,max_chars:Number.MAX_SAFE_INTEGER};
}

export function nativeTextCapacityIssue(native,text) {
  if(!text||native?.type!=='text'||!(native.width>0&&native.height>0&&native.font_pt>0))return null;
  return fieldIssue(nativeTextField('text',native),text)||null;
}

function compositionTextTargets(instances,components,originals) {
  const targets=[];
  const add=(object,key,native,optional=false)=>{
    if(native?.type!=='text'||!(native.width>0&&native.height>0&&native.font_pt>0)||
      (!optional&&typeof object[key]!=='string'))return;
    const field=nativeTextField(key,native);
    targets.push({field,get:()=>object[key]||'',set:text=>{object[key]=text;},capacity:native.width*native.height/native.font_pt**2});
  };
  for(const instance of instances) {
    const component=components.find(c=>c.component_id===instance.component_id&&c.component_version===instance.component_version);
    if(!component)continue;
    if(instance.transform&&Array.isArray(instance.bindings?.steps)) {
      for(const step of instance.bindings.steps)for(const [name,sourceKey] of Object.entries(component.parameterization?.fields||{}))
        add(step,name,component.slots.find(slot=>slot.key===String(sourceKey))?.native_shape);
    } else for(const slot of component.slots||[]) {
      if(slot.type==='text')add(instance.bindings,slot.key,slot.native_shape);
      if(slot.type==='table')for(const [row,cells] of (instance.bindings?.[slot.key]?.cells||[]).entries())
        for(const [column] of cells.entries())if(!slot.native_shape?.merged_continuations?.some(([r,c])=>r===row&&c===column))
          add(cells,column,slot.native_shape?.text_cells?.[row]?.[column]);
    }
  }
  for(const original of originals)if(['text','shape'].includes(original.kind))add(original,'text',{
    type:'text',...original.rect,font_pt:original.kind==='text'?28:20,text_insets:{left:0,right:0,top:0,bottom:0}},true);
  return targets;
}

export function compositionCapacityIssue(instances,components,originals=[]) {
  for(const target of compositionTextTargets(instances,components,originals)) {
    const text=target.get();
    if(!text)continue;
    const issue=fieldIssue(target.field,text);
    if(issue)return 'SLOT_CAPACITY：'+issue;
  }
  return null;
}

export function completeCompositionPointBindings(page,instances,components,originals=[]) {
  const result={instances:structuredClone(instances),originals:structuredClone(originals),completed_points:[]};
  const targets=compositionTextTargets(result.instances,components,result.originals);
  let visible=normalizeCompositionText(compositionBindingStrings([...result.instances,
    {bindings:{original_text:result.originals.map(o=>o.text||'')}}]).join(''));
  for(const [index,point] of (page.key_points||[]).entries()) {
    const normalized=normalizeCompositionText(point);
    if(!normalized||visible.includes(normalized))continue;
    const choices=targets.map(target=>({target,text:[target.get(),point].filter(Boolean).join('\n')}))
      .filter(choice=>!fieldIssue(choice.target.field,choice.text))
      .sort((a,b)=>Number(Boolean(a.target.get()))-Number(Boolean(b.target.get()))||b.target.capacity-a.target.capacity);
    if(!choices.length)continue;
    choices[0].target.set(choices[0].text);visible+=normalized;result.completed_points.push(index+1);
  }
  return result;
}

export function componentContentIssue(page,instances) {
  const normalize=normalizeCompositionText,strings=compositionBindingStrings(instances);
  const expected=(page.key_points || []).map(normalize),visible=normalize(strings.join(''));
  const missing=expected.find(point=>point&&!visible.includes(point));
  if(missing)return '组件绑定缺少本页内容，请逐条保留key_points原文：'+missing;
  const source=normalize([page.title,...(page.key_points || [])].join(''));
  for(const text of strings)for(const sentence of text.split(/[，。；！？\n·、：:]/)) {
    const value=normalize(sentence);
    if(value.length>8&&!source.includes(value))return '组件文字超出本页来源，不得为凑节点新增动作或效果：'+sentence;
  }
  return null;
}

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

function suggestedContentChars(page,slots) {
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
  if(!Array.isArray(value.fields) || value.fields.length!==slots.length || new Set(value.fields.map(f=>f?.id)).size!==slots.length || slots.some(s=>!value.fields.some(f=>f?.id===s.id))) return 'fields 必须完整且不重复地且仅包含这些编号 '+JSON.stringify(slots.map(s=>s.id))+'；实际编号 '+JSON.stringify(Array.isArray(value.fields)?value.fields.map(f=>f?.id):value.fields);
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
  // The author's coverage declaration is advisory; actual draft requirements remain unverified until human review.
  if(!Array.isArray(value.evidence_ids) || (sources.length && !value.evidence_ids.length) || value.evidence_ids.some(id=>!sources.some(s=>s.id===id))) return 'evidence_ids 必须选择提供的原文编号；无材料时使用空数组';
  const original=sources.filter(s=>value.evidence_ids.includes(s.id)).map(s=>s.quote).join('\n');
  if(claimsMeasured(text) && !claimsMeasured(original)) return '原文没有实测/已验证证据，必须保留初步测算、预计或计划等事实状态';
  if(checkRichness) return missingNameIssue(value,page,sources);
}

export async function fitContentFields(model,content,page,slots,sources) {
  return withPptOperation(()=>fitContentFieldsCore(model,content,page,slots,sources));
}
async function fitContentFieldsCore(model,content,page,slots,sources) {
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
        if(!await requestPptCorrection('字段容量修正')) throw apiError('LLM_BAD_OUTPUT','本次生成已用过一次自动纠正，请人工调整当前草稿');
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
    if(round===1 || !redistributionIssue) break;
    if(!await requestPptCorrection('内容重新分配')) throw apiError('LLM_BAD_OUTPUT','本次生成已用过一次自动纠正，请人工调整当前草稿');
    content=await chatJson({model,timeoutMs:600000,system:[
        '当前页面需调整内容分配以解决字段容量或名称遗漏。依据提供的原文及当前正文，将长模型名、实体、数字及完整机制移到有剩余容量的正文区，短字段只保留中文职责或标签；issue 指出的溢出字段必须改写，完整英文名称移到长正文区，不能原样返回。不能删除关键事实。补充输入、处理机制、输出、条件与依据。',
        'required_names 中的完整名称必须逐字保留，并分配到 name_fields 指定的宽正文区，结合原文解释机制；其余窄字段只写中文动作/职责标签，不填写英文模型全称。不能将完整名称塞回原来的窄框，也不能只保留简称。',
        'page_target_chars仅为密度建议，不为凑字数扩写；按原文和用户要求决定详略，解决指出的容量或名称问题。每个字段不得超过max_chars和max_lines（含自动折行）。不要删字段或大纲要点，不增加无依据事实，保留预计、初步测算、计划等事实限定。',
        '只输出JSON {"fields":[{"id":"原编号","text":"完整正文"}],"evidence_ids":["原文编号"],"covered_points":[1,2]}，覆盖全部字段和大纲要点。',
      ].join('\n'),messages:[{role:'user',content:JSON.stringify({page,page_target_chars:suggestedContentChars(page,slots),required_names:requiredNames(page,sources),name_fields:[...slots].sort((a,b)=>b.max_chars-a.max_chars).slice(0,2).map(s=>s.id),redistribution_issue:redistributionIssue,fields:slots.map(s=>({id:s.id,name:s.name,max_chars:s.max_chars,max_lines:s.max_lines,target_chars:Math.max(1,Math.floor(s.max_chars*0.8)),current_text:content.fields.find(f=>f.id===s.id).text,issue:fieldIssue(s,content.fields.find(f=>f.id===s.id).text)})),sources})}]},v=>contentIssue(v,page,slots,sources,false,true));
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

export async function generateSlideContent(id,page,slide,qualityFeedback='') {
  checkCancelled();
  const {meta}=await loadProject(id),model=await resolveModel(meta.dialogue_model);
  if(!model.online) throw apiError('LLM_UNAVAILABLE','逐页正文生成需要可用模型：'+(model.reason || model.label));
  const slots=contentSlots(slide),allSources=await originalSources(id),sources=pageSources(page,allSources);
  const reviewContext=stableHash({schema:12,plan:await planFingerprint(id),sources:allSources,model:{id:model.id,tag:model.tag}});
  const fingerprint=stableHash({schema:12,reviewContext,input:await inputFingerprint(id),page,slots,sources:allSources.filter(s=>!s.id.startsWith('brief:')),model:{id:model.id,tag:model.tag}});
  const file=path.join(projectDir(id),'slide-content.json');
  const savedCache=await readJson(file,null);
  const cache=Array.isArray(savedCache?.pages)?savedCache:{pages:[]};
  const saved=cache.pages?.find(p=>p.n===page.n && p.fingerprint===fingerprint);
  if(saved && !qualityFeedback && !contentIssue(saved.content,page,slots,sources)) return saved.content;
  const draft=async feedback=>{
  feedback=[qualityFeedback,feedback].filter(Boolean).join('\n');
  let content=await chatJson({model,timeoutMs:600000,system:[
    '你是 PPT 正文作者，必须把大纲展开为可直接展示的完整内容，而不是规划说明。',
    'fields 的id必须恰好为 '+JSON.stringify(slots.map(s=>s.id))+'，不增删、不重复；不得照抄示例编号。',
    'sources内的instructions/goal/brief/制作要求是要求，不是展示事实；completed中的本人结论须结合职责和原事实，不沿用已过期的待核算说明。',
    '逐项保留原文所有并列对象、责任主体、先后条件、否定和未决状态，不得概括吞掉事实或实体限定；原文简短且字段足够时优先保留原句，把全文动作及所有条件放入正文适当字段，不为凑短改写原始对象名称。页数、生成流程、禁止编造等制作指令仅用于自检，不得写入fields；业务本身的操作约束应正常保留。收尾每条事项应概括原文具体动作及条件，不能仅写“操作约束”“待确认事项”等类别标签；字段虽短，仍用原文有依据的动作短句。',
    ...(feedback?['独立业务复核要求重新生成：'+feedback]:[]),
    '原文是事实依据，大纲仅是结构。如果两者冲突，以原文为准。不得把预计、初步测算、试点或计划写成实测、已实施或已验证，不虚构数字、案例、评分或完成状态。',
    '按模板字段组织正文：短字段写分区标题/标签，长字段展开输入、步骤、技术机制、输出、证据、使用条件；表格逐格填写，单一字段不要塞全部要点。',
    'required_names 中的完整名称分配到 name_fields 指定的宽正文区，结合原文介绍机制。max_chars 不足16的窄字段只写中文职责/动作标签，不能塞入完整英文模型名称再靠删除名称压缩。',
    '通常内容页建议220–400字，材料简短时据实保持简短，不为凑字数扩写；page_target_chars只是内部密度建议，用户明确字数要求仍须保留核验。封面/收尾简洁。优先控制在每个字段target_chars左右，max_chars 是硬上限，长英文和符号也计入字数；换行会消耗容量，只在长正文区分段。详细信息只来自原文，无依据的建议必须写明建议/待验证。',
    '输出 JSON {"fields":[{"id":"字段编号","text":"完整正文"}],"evidence_ids":["原文编号"],"covered_points":[1,2]}。fields必须包含每个字段且都非空，covered_points列出全部已融入正文的大纲要点编号。只选择原文中存在的evidence_ids，选择3–6个最相关编号，不抄写原文；原文不足3条时选择全部，无材料时空数组。',
  ].join('\n'),messages:[{role:'user',content:JSON.stringify({requirements:briefSummary(await loadBrief(id)),page,page_target_chars:suggestedContentChars(page,slots),required_names:requiredNames(page,sources),name_fields:[...slots].sort((a,b)=>b.max_chars-a.max_chars).slice(0,2).map(s=>s.id),fields:slots.map(({id,name,max_chars,max_lines})=>({id,name,max_chars,max_lines,target_chars:Math.max(1,Math.floor(max_chars*0.75))})),sources})}]},v=>contentIssue(v,page,slots,sources,false));
  return fitContentFields(model,content,page,slots,sources);
  };
  const outline=await readJson(path.join(projectDir(id),'outline.json'),null);
  const completedPages=cache.pages.filter(p=>p.n!==page.n&&p.review_context_fingerprint===reviewContext).map(p=>({n:p.n,page:p.page,content:p.content}));
  const source={userInstructions:groundedText((await loadBrief(id))?.user_instructions||''),requirements:briefSummary(await loadBrief(id)),reviewScope:{kind:'single_page',currentPage:page.n,pageRole:page.relation},page,layoutFields:slots.map(({id,name,kind,max_chars,max_lines})=>({id,name,kind,max_chars,max_lines})),outline:outline?.pages||[],completedPages,sources};
  // Summary completeness can only be judged against the full deck, before build.
  const content=/封面|收尾/.test(page.relation)?await draft(''):await reviewDraft({model,advisory:true,stage:'content',projectId:id,source,draft});
  checkCancelled();
  await writeJson(file,{schema:1,pages:[...(cache.pages || []).filter(p=>p.n!==page.n),{n:page.n,fingerprint,review_context_fingerprint:reviewContext,page,model:model.tag,content,sources:sources.filter(s=>content.evidence_ids.includes(s.id))}]});
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
