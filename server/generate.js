/**
 * 汇文 PPT 后端 · 生成编排（server/generate.js，WF-06）
 * plan.json → studio.py build（样张/正式两阶段门禁）→ LibreOffice 渲染 PNG → 巡检与报告。
 * 内容填充：版式 inspection 的可编辑文本形状，确定性规则（标题/正文要点直填，不虚构）。
 * 任务走 jobs 框架（可取消、断点标记、步骤进度）。
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config } from './config.js';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, sha256File, nowIso, apiError } from './util.js';
import { studio as studioRun, buildDeck } from './studio.js';
import { renderPptxToPngs } from './render.js';
import { buildIndex } from './index-builder.js';
import { getPlan } from './planner.js';
import { loadOutline } from './outline.js';
import { loadBrief } from './brief.js';
import { createJob, getJob, startJob, setStep } from './jobs.js';

export const GEN_STEPS = ['准备构建操作', '构建 PPTX', 'LibreOffice 渲染', '巡检与报告'];

/* 家族 → 已批准模板目录（动态扫描 manifest，避免硬编码 id） */
async function resolveTemplateDir(family) {
  const root = path.join(config().dataDir, 'library', 'templates');
  const want = { 'green-clean-business': '绿色简洁商务', 'green-office-illustrated': '绿色办公插画' }[family];
  if (!want) throw apiError('INVALID_OPERATION', '未知风格家族：' + family);
  const dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const m = await readJson(path.join(root, d.name, 'manifest.json'), null);
    if (m && (m.name === want || m.family === family)) {
      if (m.status !== 'approved') {
        throw apiError('TEMPLATE_NOT_APPROVED', '模板未批准：' + d.name);
      }
      return path.join(root, d.name);
    }
  }
  throw apiError('SOURCE_NOT_FOUND', '找不到风格对应的已批准模板：' + family);
}

/* inspection.json → 该页可编辑文本形状（标题优先，跳过页码/日期类） */
function textShapes(slide) {
  const els = (slide.elements || []).filter((e) => e.editable_text && e.kind === 'sp');
  const skip = /页码|日期|编号|序号|logo|版本|version/i;
  const title = els.find((e) => /标题|题/.test(e.name || '')) || els[0] || null;
  const rest = els.filter((e) => e !== title && !skip.test(e.name || ''));
  return { title, rest };
}

/* 内容填充策略：标题 ← 页标题；其余形状 ← purpose / key_points（直填不虚构） */
function fillOperations(page, slide, outIndex) {
  const { title, rest } = textShapes(slide);
  const ops = [];
  const texts = [];
  if (page.purpose) texts.push(page.purpose);
  for (const k of page.key_points || []) texts.push(k);
  if (title && page.title) {
    ops.push({ op: 'set-text', slide: outIndex, shape_id: title.shape_id, text: String(page.title).slice(0, 60) });
  }
  /* 0.3.3：材料派生文本直填更多正文形状（purpose/key_points 优先）；标题不兜底进正文（直填不虚构） */
  rest.slice(0, 4).forEach((sh, i) => {
    const text = texts[i] || '';
    if (text) ops.push({ op: 'set-text', slide: outIndex, shape_id: sh.shape_id, text: String(text).slice(0, 120) });
  });
  return ops;
}

/* 构建阶段准备：plan → studio build plan（含门禁与逐页操作） */
export async function prepareBuildPlan(projectId, phase = 'sample') {
  if (!['sample', 'final'].includes(phase)) throw apiError('INVALID_OPERATION', 'phase 必须是 sample 或 final');
  const plan = await getPlan(projectId);
  if (!plan) throw apiError('REQUIRED_FIELD_MISSING', '尚无执行计划，先完成 WF-05');
  const brief = await loadBrief(projectId);
  const outline = await loadOutline(projectId);
  const requirements = brief && brief.approvals && brief.approvals.requirements;
  const outlineApproval = outline && outline.approvals && outline.approvals.outline;
  if (!requirements) throw apiError('REQUIRED_FIELD_MISSING', '需求摘要未确认（WF-02 门禁）');
  if (!outlineApproval) throw apiError('REQUIRED_FIELD_MISSING', '大纲未确认（WF-03 门禁）');
  const index = await buildIndex();
  const layoutById = new Map(index.layouts.map((l) => [l.id, l]));
  const slides = [];
  for (const p of plan.pages) {
    const lay = layoutById.get(p.layout_id);
    if (!lay || lay.template_slide == null) {
      throw apiError('UNSUPPORTED_OBJECT', '版式缺少模板页映射：' + p.layout_id);
    }
    const insp = await readJson(path.join(await resolveTemplateDir(lay.family), 'inspection.json'), null);
    if (!insp) throw apiError('SOURCE_NOT_FOUND', '模板 inspection 缺失：' + lay.family);
    /* 0.3.4.3 防御：版式页号越界（如历史索引数据）时按模板页数取模回落，生成不因此失败 */
    const slidesArr = insp.slides || [];
    if (!slidesArr.length) throw apiError('SOURCE_NOT_FOUND', '模板无可用页：' + lay.family);
    const slide = slidesArr[((lay.template_slide - 1) % slidesArr.length + slidesArr.length) % slidesArr.length];
    slides.push({ source_slide: lay.template_slide, operations: fillOperations(p, slide, plan.pages.indexOf(p) + 1) });
  }
  const buildPlan = {
    phase,
    approvals: {
      requirements: { confirmed_by: requirements.confirmed_by, note: requirements.note },
      outline: { confirmed_by: outlineApproval.confirmed_by, note: outlineApproval.note },
    },
    slides,
  };
  await writeJson(path.join(projectDir(projectId), 'build-plan.json'), buildPlan);
  return buildPlan;
}

export async function nextVersionLabel(projectId) {
  const vdir = path.join(projectDir(projectId), 'versions');
  const files = fs.existsSync(vdir) ? (await fsp.readdir(vdir)).filter((f) => /^revision-\d+\.pptx$/.test(f)) : [];
  const n = files.length + 1;
  return { label: 'v' + String(n).padStart(4, '0'), file: 'revision-' + String(n).padStart(3, '0') + '.pptx' };
}

/** 门禁预校验（同步抛出，让 HTTP 层直接返回 4xx 而不是异步任务失败） */
async function assertGenerateGates(projectId) {
  const plan = await getPlan(projectId);
  if (!plan) throw apiError('REQUIRED_FIELD_MISSING', '尚无执行计划，先完成 WF-05');
  const brief = await loadBrief(projectId);
  if (!(brief && brief.approvals && brief.approvals.requirements)) {
    throw apiError('REQUIRED_FIELD_MISSING', '需求摘要未确认（WF-02 门禁）');
  }
  const outline = await loadOutline(projectId);
  if (!(outline && outline.approvals && outline.approvals.outline)) {
    throw apiError('REQUIRED_FIELD_MISSING', '大纲未确认（WF-03 门禁）');
  }
  return plan;
}

/** 发起生成任务（异步执行，客户端轮询 /jobs/:id） */
export async function startGenerate(projectId, { phase = 'sample' } = {}) {
  const { meta } = await loadProject(projectId);
  if (meta.stage === 'generating') throw apiError('INVALID_OPERATION', '已有生成任务进行中');
  await assertGenerateGates(projectId);
  const job = createJob('generate', projectId, { phase });
  const tplDirByFamily = {};
  startJob(job, async (j) => {
    await updateProjectMeta(projectId, { stage: 'generating', next_action: '生成中' });
    try {
      /* 1) 准备构建操作 */
      setStep(j, 0);
      const plan = await getPlan(projectId);
      const fam = plan.style_selection.custom_style ? 'green-clean-business' : plan.style_selection.family; // 自定义风格沿用所选分支的通用版式
      const tplDir = await resolveTemplateDir(fam);
      tplDirByFamily[fam] = tplDir;
      const buildPlan = await prepareBuildPlan(projectId, phase);

      /* 2) 构建 PPTX */
      setStep(j, 1);
      const ver = await nextVersionLabel(projectId);
      const outPptx = path.join(projectDir(projectId), 'versions', ver.file);
      await buildDeck(tplDir, path.join(projectDir(projectId), 'build-plan.json'), outPptx);
      const sha = await sha256File(outPptx);

      /* 3)+4) 渲染 + 巡检 + 报告 + 状态推进（与修订链路共用） */
      setStep(j, 2);
      const out = await finalizeVersion(projectId, outPptx, { phase, label: ver.label, file: ver.file, expectedSlides: buildPlan.slides.length });
      setStep(j, 3);
      return { ...out, failed: out.report.structural !== 'pass' || out.report.render !== 'pass' };
    } catch (e) {
      await updateProjectMeta(projectId, { stage: 'pages', next_action: '重试生成（上次失败：' + String(e.message).slice(0, 40) + '）' }).catch(() => {});
      throw e;
    }
  });
  return { job_id: job.id };
}

export { getJob };

/** 渲染 + 巡检 + 报告 + 项目状态推进（生成与修订共用） */
export async function finalizeVersion(projectId, outPptx, { phase, label, file, expectedSlides }) {
  const renderDir = path.join(projectDir(projectId), 'renders', label);
  const render = await renderPptxToPngs(outPptx, renderDir);
  const sha = await sha256File(outPptx);
  const inspPath = path.join(projectDir(projectId), 'inspection-' + label + '.json');
  await studioRun(['inspect', '--source', outPptx, '--output', inspPath]);
  const insp = await readJson(inspPath, {});
  const slideCount = (insp.slides || []).length;
  const editablePages = (insp.slides || []).filter((s) => (s.elements || []).some((e) => e.editable_text)).length;
  const report = {
    project_id: projectId,
    version: label,
    phase,
    file: 'versions/' + file,
    sha256: sha,
    slide_count: slideCount,
    editable_pages: editablePages,
    engine: 'libreoffice',
    engine_version: render.engine_version || null,
    render: (render.files || []).length ? 'pass' : 'failed',
    render_pngs: (render.files || []).map((f) => 'renders/' + label + '/' + f.file),
    font_substitutions: (render.warnings || []).filter((w) => w.type === 'font_substitution').map((w) => w.note),
    structural: expectedSlides ? (slideCount === expectedSlides ? 'pass' : 'failed') : 'pass',
    checked_at: nowIso(),
  };
  await writeJson(path.join(projectDir(projectId), 'report-' + label + '.json'), report);
  const failed = report.structural !== 'pass' || report.render !== 'pass';
  await updateProjectMeta(projectId, {
    stage: 'done',
    version: label,
    source_name: file,
    source_sha256: sha,
    page_count: slideCount,
    next_action: failed ? '检查生成报告' : '画布审阅与修订',
    checks: {
      structural: report.structural,
      render: report.render,
      visual_review: 'pending',
      editability: editablePages > 0 ? 'pass' : 'pending',
      user_acceptance: 'pending',
    },
    latest_report: 'report-' + label + '.json',
  });
  return { version: label, file, sha256: sha, slide_count: slideCount, editable_pages: editablePages, report };
}
