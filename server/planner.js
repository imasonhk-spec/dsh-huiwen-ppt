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
  await fsp.writeFile(target, buf);
  const theme = await runPython([SCRIPT, target], 30000);
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
  const n = Math.max(1, Math.min(500, parseInt(count, 10) || 8));
  const index = await buildIndex();
  const isBuiltin = index.styles.some((s) => s.id === family);
  const customStyle = await getCustomStyle(projectId);
  const isCustom = family === (customStyle && customStyle.id);
  if (!isBuiltin && !isCustom) {
    throw apiError('INVALID_OPERATION', '未知风格：' + family + '（内置分支或先导入自定义模板）');
  }
  const sel = {
    family,
    count: n,
    custom_style: isCustom ? { id: customStyle.id, name: customStyle.name, sha256: customStyle.template_sha256 } : null,
    selected_at: nowIso(),
  };
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

function layoutPool(index, relation, family, customMode) {
  /* 0.3.3：custom_mode 的构建模板固定为绿色简洁商务（generate.startGenerate），版式池须与之同族
   * 0.3.4.3：参考图构图包（reference_pack / reference_fidelity_reconstruction / id 含 reference-）是构图参考而非模板页，
   * 其 template_slide 无对应 inspection 页（曾致「模板页越界 #19」生成失败）——所有模式均排除 */
  const isReference = (l) => l.pack === 'reference_pack' || l.origin === 'reference_fidelity_reconstruction' || /reference-/.test(l.id);
  const famMatch = (l) => {
    if (customMode) return l.family === 'green-clean-business' && l.approval === 'approved' && !isReference(l) ? 1 : 0;
    return l.family === family && !isReference(l) ? 1 : 0;
  };
  const byRel = (rel) => index.layouts.filter((l) => l.relation === rel && famMatch(l));
  /* 优先级：本族该 relation → 归一映射后的本族 relation → 本族全部 → 全库兜底（库无本族版式时） */
  let pool = byRel(relation);
  if (!pool.length && REL_FALLBACK[relation]) pool = byRel(REL_FALLBACK[relation]);
  if (!pool.length) pool = index.layouts.filter(famMatch);
  if (!pool.length) pool = index.layouts.filter((l) => l.relation === relation);
  if (!pool.length) pool = index.layouts.filter((l) => l.relation === '内容页');
  if (!pool.length) pool = index.layouts.slice();
  return pool.sort((a, b) => a.id.localeCompare(b.id));
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
  const EXTRA = [['总结与展望', '总结'], ['团队介绍', '人员'], ['风险与对策', '治理'], ['下一步计划', '计划'], ['互动答疑', '互动']];
  let basePages = outline.pages.map((p) => ({ ...p }));
  let ei = 0;
  while (basePages.length < sel.count) {
    const [t, rel] = EXTRA[ei % EXTRA.length];
    basePages.push({ n: 0, title: t + (ei >= EXTRA.length ? '（' + (Math.floor(ei / EXTRA.length) + 1) + '）' : ''), purpose: '扩展页（执行计划补足）', key_points: [], evidence: '', relation: rel });
    ei += 1;
  }
  basePages = basePages.slice(0, sel.count).map((p, i) => ({ ...p, n: i + 1 }));
  const pages = basePages.map((p, i) => {
    const prev = cur && cur.pages && cur.pages[i] && cur.pages[i].title === p.title ? cur.pages[i] : null;
    const pool = layoutPool(index, p.relation, sel.family, customMode);
    const alt = prev ? prev.alt % pool.length : 0;
    const layout = pool[alt];
    if (!layout || !validIds.has(layout.id)) {
      throw apiError('UNSUPPORTED_OBJECT', '版式池为空：' + p.relation);
    }
    return { n: p.n, title: p.title, relation: p.relation, alt, layout_id: layout.id, purpose: p.purpose || '', key_points: p.key_points || [] };
  });
  const plan = {
    style_selection: sel,
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
  const pool = layoutPool(index, page.relation, plan.style_selection.family, !!plan.style_selection.custom_style);
  if (pool.length < 2) return page; // 单版式关系无从换
  const next = (page.alt + 1) % pool.length;
  page.alt = next;
  page.layout_id = pool[next].id;
  plan.updated_at = nowIso();
  await writeJson(planPath, plan);
  return page;
}

export async function getPlan(projectId) {
  return readJson(path.join(projectDir(projectId), 'plan.json'), null);
}

/** plan → 客户端 pageLayouts 卡片形状 */
export function planToPageLayouts(plan) {
  return (plan.pages || []).map((p) => ({ n: p.n, title: p.title, rel: p.relation, alt: p.alt, layoutId: p.layout_id }));
}
