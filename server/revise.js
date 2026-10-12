/**
 * 汇文 PPT 后端 · 修订（server/revise.js，WF-07）
 * 双通道：① 对话通道——解析指令（LLM 主路 + 规则兜底）→ 操作；② 画布通道——属性面板编辑文字 → 操作队列。
 * 统一走 studio.py patch（SHA256 乐观锁 expected_sha256）→ 新版本 → finalizeVersion（渲染/巡检/报告）。
 */

import path from 'node:path';
import fs from 'node:fs';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, nowIso, apiError } from './util.js';
import { studio as studioRun, patchSource } from './studio.js';
import { resolveModel, chat } from './llm.js';
import { nextVersionLabel, finalizeVersion } from './generate.js';

/** 当前工作版本（修订基准） */
export async function currentVersion(projectId) {
  const { meta } = await loadProject(projectId);
  if (!meta.version || !meta.source_name || !meta.source_sha256) {
    throw apiError('INVALID_OPERATION', '尚无可修订的版本，先生成（WF-06）');
  }
  const file = path.join(projectDir(projectId), 'versions', meta.source_name);
  if (!fs.existsSync(file)) throw apiError('SOURCE_NOT_FOUND', '版本文件缺失：' + meta.source_name);
  return { label: meta.version, file: meta.source_name, path: file, sha256: meta.source_sha256, stage: meta.stage };
}

/** 指定页可编辑形状（画布属性面板数据源） */
export async function pageShapes(projectId, page) {
  const cur = await currentVersion(projectId);
  const insp = await readJson(path.join(projectDir(projectId), 'inspection-' + cur.label + '.json'), null);
  if (!insp) throw apiError('SOURCE_NOT_FOUND', '当前版本巡检数据缺失');
  const n = parseInt(page, 10);
  const slide = (insp.slides || [])[n - 1];
  if (!slide) throw apiError('SOURCE_NOT_FOUND', '页码越界：' + n + '（共 ' + (insp.slides || []).length + ' 页）');
  return {
    version: cur.label,
    sha256: cur.sha256,
    page: n,
    slide_count: (insp.slides || []).length,
    shapes: (slide.elements || []).filter((e) => e.editable_text && e.kind === 'sp')
      .map((e) => ({ shape_id: e.shape_id, name: e.name, text: e.text || '' })),
  };
}

/* ── 指令解析 ── */

function ruleParse(text, shapesByPage) {
  const t = String(text || '');
  const mPage = t.match(/第\s*(\d+)\s*页/);
  const mText = t.match(/(?:改成|改为|换成|调整为|更新为)\s*[「"'“]?([^」"'”]+)[」"'”]?/);
  if (!mPage || !mText) return null;
  const page = parseInt(mPage[1], 10);
  const shapes = (shapesByPage[page] || []).filter((s) => /标题|题/.test(s.name || '')) || [];
  const shape = shapes[0] || shapesByPage[page][0];
  if (!shape) return null;
  const ops = [{ slide: page, shape_id: shape.shape_id, op: 'set-text', text: mText[1].trim().slice(0, 120) }];
  return { ops, note: '规则解析：第 ' + page + ' 页「' + shape.name + '」→「' + mText[1].trim() + '」' };
}

async function llmParse(model, text, shapesByPage) {
  const brief = Object.entries(shapesByPage).map(([p, shapes]) =>
    '第' + p + '页可编辑形状：' + JSON.stringify(shapes.map((s) => ({ shape_id: s.shape_id, name: s.name, text: (s.text || '').slice(0, 40) })))).join('\n');
  const content = await chat({
    model, // 完整模型对象：按 channel 分发（ollama 原生 / DSH OpenAI-compatible）
    system: [
      '你是汇文 PPT 修订助手。用户会给修改指令，当前版本每页可编辑文本形状如下（含现文字）：',
      brief,
      '规则：只输出 JSON：{"changes": [{"slide": 页号, "shape_id": "形状ID", "text": "新文字"}], "reply": "给用户的一句话确认"}。',
      '不改不存在的页/形状；文字不虚构用户未提供的事实；一次指令可含多处修改。',
    ].join('\n'),
    messages: [{ role: 'user', content: text }],
    json: true,
    timeoutMs: 180000,
  });
  const m = content && content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型输出不是 JSON');
  const parsed = JSON.parse(m[0]);
  const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
  const ops = changes
    .filter((c) => c && shapesByPage[c.slide] && shapesByPage[c.slide].some((s) => s.shape_id === String(c.shape_id)))
    .map((c) => ({ slide: c.slide, shape_id: String(c.shape_id), op: 'set-text', text: String(c.text || '').slice(0, 120) }));
  if (!ops.length) throw new Error('模型未产出有效修改');
  return { ops, note: parsed.reply || '' };
}

/** 对话通道：解析并应用 */
export async function reviseFromInstruction(projectId, text, modelId) {
  const cur = await currentVersion(projectId);
  const insp = await readJson(path.join(projectDir(projectId), 'inspection-' + cur.label + '.json'), null);
  if (!insp) throw apiError('SOURCE_NOT_FOUND', '当前版本巡检数据缺失');
  const shapesByPage = {};
  (insp.slides || []).forEach((s) => {
    shapesByPage[s.number] = (s.elements || []).filter((e) => e.editable_text && e.kind === 'sp')
      .map((e) => ({ shape_id: e.shape_id, name: e.name, text: e.text || '' }));
  });
  let parsed = null, via = 'rule';
  let modelInfo = null;
  let model = null;
  try { model = await resolveModel(modelId); modelInfo = { id: model.id, label: model.label, tag: model.tag }; } catch { model = null; }
  if (model && model.online) {
    try { parsed = await llmParse(model, text, shapesByPage); via = 'llm'; } catch { parsed = null; }
  }
  if (!parsed) parsed = ruleParse(text, shapesByPage);
  if (!parsed) {
    return { applied: false, reply: '暂时没能把这个指令对应到具体页面的文字对象。可以试试「把第 2 页标题改成 XXX」，或在右侧画布的形状列表里直接编辑。', model: modelInfo, via };
  }
  const r = await applyPatch(projectId, parsed.ops, { source: 'dialogue', note: parsed.note });
  return { applied: true, reply: parsed.note || ('已按指令修订并生成新版本 ' + r.version), ...r, model: modelInfo, via };
}

/** 画布通道：操作队列应用（SHA256 乐观锁） */
export async function applyPatch(projectId, operations, { source = 'canvas', note = '' } = {}) {
  const cur = await currentVersion(projectId);
  if (!Array.isArray(operations) || !operations.length) {
    throw apiError('REQUIRED_FIELD_MISSING', '修订操作为空');
  }
  for (const op of operations) {
    if (!op || !Number.isInteger(op.slide) || op.slide < 1 || !op.shape_id || !['set-text', 'replace-text'].includes(op.op)) {
      throw apiError('INVALID_OPERATION', '操作格式不合法：' + JSON.stringify(op).slice(0, 80));
    }
    if (op.op === 'set-text' && typeof op.text !== 'string') throw apiError('INVALID_OPERATION', 'set-text 缺少 text');
  }
  const patch = {
    expected_sha256: cur.sha256,
    operations,
    meta: { project_id: projectId, source, note, created_at: nowIso() },
  };
  const patchPath = path.join(projectDir(projectId), 'patch-' + Date.now().toString(36) + '.json');
  await writeJson(patchPath, patch);
  const ver = await nextVersionLabel(projectId);
  const outPptx = path.join(projectDir(projectId), 'versions', ver.file);
  try {
    await patchSource(cur.path, patchPath, outPptx);
  } catch (e) {
    if (/SHA256 mismatch|mismatch or missing/i.test(String(e.message))) {
      throw apiError('SOURCE_HASH_MISMATCH', '版本已变化（乐观锁生效），请刷新画布后重试');
    }
    throw e;
  }
  fs.rmSync(patchPath, { force: true });
  const out = await finalizeVersion(projectId, outPptx, { phase: 'sample', label: ver.label, file: ver.file, expectedSlides: null });
  return {
    applied: true,
    version: out.version,
    file: out.file,
    sha256: out.sha256,
    slide_count: out.slide_count,
    report: out.report,
    source,
    note,
  };
}

/** 版本回滚（WF-07）：把指定旧版本内容登记为新修订（版本链不断、审计可查），并重渲染 */
export async function rollbackVersion(projectId, label) {
  const { meta } = await loadProject(projectId);
  if (!label || label === meta.version) throw apiError('INVALID_OPERATION', '回滚目标需与当前版本不同');
  const digits = String(parseInt(label.replace('v', ''), 10));
  const src = path.join(projectDir(projectId), 'versions', 'revision-' + digits.padStart(3, '0') + '.pptx');
  if (!fs.existsSync(src)) throw apiError('SOURCE_NOT_FOUND', '目标版本文件不存在：' + label);
  const ver = await nextVersionLabel(projectId);
  const outPptx = path.join(projectDir(projectId), 'versions', ver.file);
  fs.copyFileSync(src, outPptx);
  const out = await finalizeVersion(projectId, outPptx, { phase: 'sample', label: ver.label, file: ver.file, expectedSlides: null });
  return { rolled_back_to: label, version: out.version, sha256: out.sha256, slide_count: out.slide_count, report: out.report };
}
