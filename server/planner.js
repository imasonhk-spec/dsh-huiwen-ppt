/**
 * 汇文 PPT 后端 · 风格选择与执行计划（server/planner.js，WF-04/WF-05）
 * style-selection：{family, count, custom_style?} 持久化到项目 style-selection.json + project.json；
 * 自定义模板：上传 PPTX/POTX → extract_theme.py 真实解析主题 → 存 projects/<id>/custom-template.pptx + custom-style.json；
 * plan.json：大纲 relation → 版式推荐（参考包优先/自定义风格走通用）→ 每页 layout_id + alt（换一换游标）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, sha256File, nowIso, apiError } from './util.js';
import { loadOutline } from './outline.js';
import { loadBrief } from './brief.js';
import { buildIndex } from './index-builder.js';
import { planFingerprint } from './dependencies.js';
import { withProjectLock } from './workflow.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'extract_theme.py');

function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(config().python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('主题解析超时'), { code: 'RENDER_FAILED' })); }, timeoutMs || 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let msg = err.trim();
        try { msg = JSON.parse(err).error || msg; } catch { /* 保留原文 */ }
        return reject(Object.assign(new Error(msg || ('主题解析失败 exit ' + code)), { code: 'UNSUPPORTED_OBJECT' }));
      }
      try { resolve(JSON.parse(out)); } catch (e) { reject(Object.assign(new Error('主题解析输出不合法'), { code: 'UNSUPPORTED_OBJECT' })); }
    });
  });
}

/* ── 自定义模板（WF-04） ── */

export async function importCustomTemplate(projectId, buf, filename) {
  const lower = String(filename || '').toLowerCase();
  if (!lower.endsWith('.pptx') && !lower.endsWith('.potx')) {
    throw apiError('INVALID_OPERATION', '自定义模板仅支持 .pptx / .potx');
  }
  const dir = projectDir(projectId);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'custom-template.pptx');
  const staged=path.join(dir,'template-upload-'+(await import('node:crypto')).randomUUID()+'.pptx');
  await fsp.writeFile(staged, buf);
  let theme;
  try { theme = await runPython([SCRIPT, staged], 30000); }
  catch(e) { await fsp.rm(staged,{force:true}); throw e; }
  await fsp.rename(staged,target);
  const meta = await loadProject(projectId);
  const custom = {
    id: 'custom-' + meta.meta.id,
    name: String(filename).replace(/\.(pptx|potx)$/i, ''),
    template_file: 'custom-template.pptx',
    template_sha256: await sha256File(target),
    theme_name: theme.theme_name,
    palette: theme.palette_list,
    palette_map: theme.palette,
    masters: theme.masters,
    slides: theme.slides,
    fonts: theme.fonts,
    fonts_label: [theme.fonts.majorFont, theme.fonts.majorFont_ea].filter(Boolean).join(' / ') || '模板默认字体',
    imported_at: nowIso(),
  };
  await writeJson(path.join(dir, 'custom-style.json'), custom);
  return custom;
}

export async function getCustomStyle(projectId) {
  return readJson(path.join(projectDir(projectId), 'custom-style.json'), null);
}

/* ── 风格选择（WF-04） ── */

export async function selectStyle(projectId, { family, count, custom }) {
  if (!family) throw apiError('REQUIRED_FIELD_MISSING', '缺少风格 family');
  const brief = await loadBrief(projectId), outline = await loadOutline(projectId);
  const n = count == null ? (brief?.page_count || outline?.pages?.length || 8) : Number(count);
  if (!Number.isInteger(n) || n < 2 || n > config().limits.pagesMax) throw apiError('INVALID_OPERATION','页数必须为 2–'+config().limits.pagesMax);
  let index = await buildIndex();
  const isBuiltin = index.styles.some((s) => s.id === family);
  const customStyle = await getCustomStyle(projectId);
  const isCustom = family === (customStyle && customStyle.id);
  if (!isBuiltin && !isCustom) {
    throw apiError('INVALID_OPERATION', '未知风格：' + family + '（内置分支或先导入自定义模板）');
  }
  let templateId = null;
  if (isCustom) {
    const { learnFromProject, approveTemplateFolder } = await import('./knowledge.js');
    const folder = await learnFromProject(projectId);
    await approveTemplateFolder(folder.id, '用户', '在项目中明确选择使用此上传模板');
    templateId = folder.id; index = await buildIndex(true);
  }
  const sel = {
    family,
    template_id: templateId,
    count: n,
    custom_style: isCustom ? { id: customStyle.id, name: customStyle.name, sha256: customStyle.template_sha256 } : null,
    selected_at: nowIso(),
  };
  if (outline?.pages?.length !== n) {
    const { saveBriefDraft } = await import('./brief.js');
    const { generateOutlineForProject } = await import('./dialogue.js');
    const { confirmOutline } = await import('./outline.js');
    await saveBriefDraft(projectId,{page_count:n});
    await generateOutlineForProject(projectId,null,'按最新页数重新组织内容：');
    await confirmOutline(projectId,'用户动作','页数变更后按请求继续制作');
  }
  await writeJson(path.join(projectDir(projectId), 'style-selection.json'), sel);
  await updateProjectMeta(projectId, { style_selection: { family: sel.family, count: sel.count }, stage: 'pages', next_action: '确认逐页版式计划' });
  return sel;
}

export async function getStyleSelection(projectId) {
  return readJson(path.join(projectDir(projectId), 'style-selection.json'), null);
}

/* ── 执行计划 plan.json（WF-05） ── */

/* 0.3.3：跨家族 relation 归一映射——所选家族缺该 relation 时映射到语义最近的本族版式。
   背景：绿色简洁商务（22 版式）与绿色办公插画（15 版式）的 relation 词表不同（指标/价值/异常 仅插画族有，
   封面/收尾 仅商务族有）；此前 layoutPool 仅"同族优先排序"不过滤，跨族版式会被选中，导致
   prepareBuildPlan 按版式家族取巡检、buildDeck 按所选家族取模板，shape_id 错位 → 生成必败
   （"Text operation requires a native slide text shape"）。 */
const REL_FALLBACK = {
  指标: '数据', 价值: '案例', 异常: '治理', 界面: '案例', 技术: '架构', 规则: '治理', 边界: '治理', 图表: '数据', 方案: '计划', 定位: '总览',
  封面: '需求', 收尾: '计划', 总览: '定位', 架构: '技术', 数据: '指标', 案例: '价值', 治理: '规则', 生态: '定位', 对比: '指标', 素材: '界面',
};

// Suitable alternatives share the selected theme; cover/closing are never body substitutes.
const REL_ALTERNATIVES = {
  '能力资产':['总览','生态','案例'], '总览':['生态','架构','案例'], '定位':['总览','生态','架构'],
  '架构':['生态','总览','技术'], '技术':['架构','生态','总览'], '生态':['总览','架构'],
  '流程':['计划','案例','需求'], '计划':['流程','案例','表格'], '需求':['案例','对比','总览'],
  '数据':['对比','表格','案例'], '指标':['数据','对比','表格'], '对比':['表格','数据'],
  '案例':['需求','流程','总览'], '价值':['案例','指标','总览'], '表格':['对比','数据'],
  '规则':['治理','流程','案例','表格','需求','对比'], '治理':['规则','流程','案例','表格','需求','对比'], '异常':['治理','规则','流程'],
};

function layoutPool(index, relation, family, customMode) {
  /* 0.3.3：custom_mode 的构建模板固定为绿色简洁商务（generate.startGenerate），版式池须与之同族
   * 0.3.4.3：参考图构图包（reference_pack / reference_fidelity_reconstruction / id 含 reference-）是构图参考而非模板页，
   * 其 template_slide 无对应 inspection 页（曾致「模板页越界 #19」生成失败）——所有模式均排除 */
  const isReference = (l) => l.pack === 'reference_pack' || l.origin === 'reference_fidelity_reconstruction' || /reference-/.test(l.id);
  const famMatch = (l) => {
    return (l.family === family || l.template_id === family) && l.approval === 'approved' && Number.isInteger(l.template_slide) && !isReference(l) ? 1 : 0;
  };
  const byRel = (rel) => index.layouts.filter((l) => l.relation === rel && famMatch(l));
  /* 优先级：本族该 relation → 归一映射后的本族 relation → 本族全部 → 全库兜底（库无本族版式时） */
  const relations=[relation,REL_FALLBACK[relation],...(REL_ALTERNATIVES[relation] || REL_ALTERNATIVES[REL_FALLBACK[relation]] || [])].filter(Boolean);
  let pool=[...new Map(relations.flatMap(byRel).map(l=>[l.id,l])).values()];
  if (!pool.length) pool=index.layouts.filter(l=>famMatch(l)&&!['封面','收尾','素材'].includes(l.relation)).sort((a,b)=>a.id.localeCompare(b.id));
  return pool;
}

export async function buildPlan(projectId, opts = {}) {
  const outline = await loadOutline(projectId);
  if (!outline || !outline.pages || !outline.pages.length) {
    throw apiError('REQUIRED_FIELD_MISSING', '尚无已确认的大纲，先完成 WF-03');
  }
  if (!outline.approvals || !outline.approvals.outline) {
    throw apiError('TEMPLATE_NOT_APPROVED', '大纲未确认（approvals.outline 缺失），不能生成执行计划');
  }
  let sel = opts.selection || await getStyleSelection(projectId);
  if (!sel) throw apiError('REQUIRED_FIELD_MISSING', '尚无风格选择，先完成 WF-04');
  const index = await buildIndex();
  const validIds = new Set(index.layouts.map((l) => l.id));
  const customMode = !!sel.custom_style;
  const cur = await readJson(path.join(projectDir(projectId), 'plan.json'), null);
  // WF-05：以风格选择页数为目标；大纲页不足时按通用候选补页（derived），超出截断（对应原客户端 EXTRA_PAGES 逻辑）
  let basePages = outline.pages.map((p) => ({ ...p }));
  if (basePages.length !== sel.count) throw apiError('STATE_REVISION_CONFLICT','大纲页数与需求不一致，需要模型重新组织内容');
  const preferences = await readJson(path.join(projectDir(projectId),'layout-preferences.json'),[]);
  const used=new Map();
  const pages = basePages.map((p, i) => {
    const prev = cur?.style_selection?.family===sel.family && cur.pages?.[i]?.title===p.title ? cur.pages[i] : null;
    const pool = layoutPool(index, p.relation, sel.template_id || sel.family, customMode);
    const preferred = preferences.find((item)=>item.n===p.n);
    const ranked=pool.map((layout,rank)=>({layout,rank})).sort((a,b)=>(used.get(a.layout.id)||0)-(used.get(b.layout.id)||0)||a.rank-b.rank);
    const legacyChoice=!cur?.layout_assignment && prev?.alt>0 ? pool.find(l=>l.id===prev.layout_id) : null;
    const layout = preferred ? index.layouts.find((l)=>l.id===preferred.layout_id && l.approval==='approved' && l.pack!=='reference_pack') : (legacyChoice || ranked[0]?.layout);
    if (!layout || !validIds.has(layout.id)) {
      throw apiError('UNSUPPORTED_OBJECT', '版式池为空：' + p.relation);
    }
    used.set(layout.id,(used.get(layout.id)||0)+1);
    const alt=Math.max(0,pool.findIndex(l=>l.id===layout.id));
    return { n: p.n, title: p.title, relation: p.relation, alt, layout_id: layout.id, template_id:layout.template_id,template_sha256:layout.source_template_sha,source_slide:layout.template_slide,purpose: p.purpose || '', key_points: p.key_points || [],evidence:p.evidence };
  });
  const plan = {
    layout_assignment: 'automatic-diverse',
    style_selection: sel,
    input_fingerprint: await planFingerprint(projectId),
    pages,
    outline_approved: outline.approvals.outline,
    brief_confirmed: ((await loadBrief(projectId)) || {}).approvals ? (((await loadBrief(projectId)) || {}).approvals.requirements || null) : null,
    created_at: cur ? cur.created_at : nowIso(),
    updated_at: nowIso(),
  };
  await writeJson(path.join(projectDir(projectId), 'plan.json'), plan);
  await updateProjectMeta(projectId, { plan_pages: pages.length });
  return plan;
}

export async function rerollPage(projectId, n) {
  const planPath = path.join(projectDir(projectId), 'plan.json');
  const plan = await readJson(planPath, null);
  if (!plan) throw apiError('INVALID_OPERATION', '尚无执行计划');
  const page = plan.pages.find((p) => p.n === Number(n));
  if (!page) throw apiError('SOURCE_NOT_FOUND', '计划中没有第 ' + n + ' 页');
  const index = await buildIndex();
  const pool = layoutPool(index, page.relation, plan.style_selection.template_id || plan.style_selection.family, !!plan.style_selection.custom_style);
  if (pool.length < 2) return page; // 单版式关系无从换
  const next = (page.alt + 1) % pool.length;
  page.alt = next;
  page.layout_id = pool[next].id;
  page.source_slide = pool[next].template_slide; page.template_id = pool[next].template_id; page.template_sha256 = pool[next].source_template_sha;
  await addLayoutPreference(projectId,page.layout_id,page.n);
  plan.updated_at = nowIso();
  await writeJson(planPath, plan);
  return page;
}

export async function getPlan(projectId) {
  return readJson(path.join(projectDir(projectId), 'plan.json'), null);
}

export async function addLayoutPreference(id, layoutId, n) {
  return withProjectLock(id,async()=>{
    await loadProject(id);
    const index=await buildIndex(),lay=index.layouts.find((l)=>l.id===layoutId);
    if(!lay || lay.approval!=='approved' || lay.pack==='reference_pack') throw apiError('UNSUPPORTED_OBJECT','只能加入已批准的实际模板页');
    const file=path.join(projectDir(id),'layout-preferences.json'), list=await readJson(file,[]);
    const page=n==null?list.length+1:Number(n);
    if(!Number.isInteger(page)||page<1||page>config().limits.pagesMax) throw apiError('INVALID_OPERATION','目标页码无效');
    const next=[...list.filter((p)=>p.n!==page),{n:page,layout_id:layoutId,template_id:lay.template_id,sha256:lay.source_template_sha}];
    await writeJson(file,next); return next;
  });
}

/** plan → 客户端 pageLayouts 卡片形状 */
export function planToPageLayouts(plan) {
  return (plan.pages || []).map((p) => ({ n: p.n, title: p.title, rel: p.relation, alt: p.alt, layoutId: p.layout_id }));
}
