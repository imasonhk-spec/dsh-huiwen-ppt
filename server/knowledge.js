/**
 * 汇文 PPT 后端 · 模板学习与知识治理（server/knowledge.js，WF-10）
 * 学习：项目上传的自定义模板 → studio register 入正式库（draft）→ 规则草稿物化 → 审批（approved）。
 * 知识：模板级候选（register 产出，source=PPTX+页码，studio 校验 sha/页码）→ 确认入库 library/knowledge/；
 *       材料级事实（txt/docx 等非 PPTX 源）自管理两级：项目候选 → 确认 → library/material-knowledge.json。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { projectDir, loadProject } from './projects.js';
import { readJson, writeJson, nowIso, apiError } from './util.js';
import { studio as studioRun, approveTemplate } from './studio.js';
import { invalidateIndex } from './index-builder.js';

const TPL_ROOT = () => path.join(config().dataDir, 'library', 'templates');
const LIB = () => path.join(config().dataDir, 'library');

async function folderInfo(dir) {
  const m = await readJson(path.join(dir, 'manifest.json'), null);
  if (!m) return null;
  const cands = await readJson(path.join(dir, 'knowledge-candidates.json'), []);
  const st = await fsp.stat(dir).catch(() => null);
  return {
    id: m.id || path.basename(dir),
    name: m.name,
    status: m.status,
    source_sha256: m.source_sha256,
    slide_count: m.slide_count,
    created_at: m.created_at || (st ? st.birthtime.toISOString() : null),
    confirmation: m.confirmation || null,
    rules_ready: Boolean(
      fs.existsSync(path.join(dir, 'visual-rules.md')) && fs.existsSync(path.join(dir, 'expression-rules.md'))
    ),
    candidates: cands.length,
    confirmed: cands.filter((c) => c.status === 'confirmed').length,
  };
}

/** 模板条目列表（含学习草稿与审批状态） */
export async function listTemplateFolders() {
  const root = TPL_ROOT();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of (await fsp.readdir(root, { withFileTypes: true })).filter((x) => x.isDirectory())) {
    const info = await folderInfo(path.join(root, d.name));
    if (info) out.push(info);
  }
  return out.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

/* 规则草稿物化（审批门禁要求两个规则文件非空；内容来自真实解析结果，标注为草稿待人工复核） */
async function materializeRules(dir, custom) {
  const visual = path.join(dir, 'visual-rules.md');
  if (!fs.existsSync(visual) || !fs.readFileSync(visual, 'utf8').trim()) {
    const lines = [
      '# 视觉规则（学习草稿 · 待人工复核）', '',
      '- 来源：项目上传模板（A3 真实解析）',
      '- 主题名：' + (custom.theme_name || '未识别'),
      '- 主色板：' + (custom.palette || []).join(' '),
      '- 母版页数：' + (custom.masters ?? '未知'),
      '- 字体规范：' + (custom.fonts_label || '模板默认'),
      '- 构建约束：文字仅写入可编辑文本形状；参考图版式（整页图）不作为文字填充对象',
      '- 渲染：服务器预览以 LibreOffice 输出，最终视觉验收以 WPS 为准', '',
    ];
    await fsp.writeFile(visual, lines.join('\n'), 'utf8');
  }
  const expr = path.join(dir, 'expression-rules.md');
  if (!fs.existsSync(expr) || !fs.readFileSync(expr, 'utf8').trim()) {
    const insp = await readJson(path.join(dir, 'inspection.json'), {});
    const rel = (insp.slides || []).map((s) => '- 第 ' + s.number + ' 页「' + (s.layout || '未命名') + '」：标题用页首标题形状，正文要点直填不虚构').join('\n');
    const lines = [
      '# 表达规则（学习草稿 · 待人工复核）', '',
      '- 填充策略：标题 ← 大纲页标题；正文 ← 大纲要点直填（不虚构数字/事实）',
      '- 版式清单：', rel || '-（无版式信息）', '',
    ];
    await fsp.writeFile(expr, lines.join('\n'), 'utf8');
  }
}

/** 从项目学习：register 项目的 custom-template.pptx 到正式模板库 */
export async function learnFromProject(projectId) {
  const { meta } = await loadProject(projectId);
  const src = path.join(projectDir(projectId), 'custom-template.pptx');
  if (!fs.existsSync(src)) throw apiError('SOURCE_NOT_FOUND', '该项目没有上传过自定义模板（WF-04）');
  const custom = await readJson(path.join(projectDir(projectId), 'custom-style.json'), {});
  const name = custom.name || meta.title || '自定义模板';
  let folder = null;
  try {
    const r = await studioRun(['register', '--source', src, '--library', LIB(), '--name', name], { timeoutMs: 60000 });
    folder = r.template;
  } catch (e) {
    if (/already exists/i.test(String(e.message))) {
      // 幂等：按 sha 前缀找回目录
      const sha = (custom.template_sha256 || '').slice(0, 10);
      const hit = (await listTemplateFolders()).find((f) => f.source_sha256 && f.source_sha256.startsWith(sha) && f.name === name);
      if (hit) folder = path.join(TPL_ROOT(), hit.id);
      else throw e;
    } else throw e;
  }
  await materializeRules(folder, custom);
  invalidateIndex();
  return { folder: path.basename(folder), ...(await folderInfo(folder)) };
}

/** 审批模板（草稿 → approved；规则文件必须已复核存在） */
export async function approveTemplateFolder(folderId, confirmedBy, note) {
  const dir = path.join(TPL_ROOT(), folderId);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw apiError('SOURCE_NOT_FOUND', '模板不存在：' + folderId);
  await approveTemplate(dir, confirmedBy || '用户', note || '模板规则复核通过');
  invalidateIndex();
  return folderInfo(dir);
}

/** 模板知识候选 */
export async function knowledgeCandidates(folderId) {
  const dir = path.join(TPL_ROOT(), folderId);
  const list = await readJson(path.join(dir, 'knowledge-candidates.json'), null);
  if (!list) throw apiError('SOURCE_NOT_FOUND', '模板不存在或未学习：' + folderId);
  return list.map((c) => ({ id: c.id, slide: c.slide, text: c.text, status: c.status, review: c.image_text_review }));
}

/** 确认模板级知识入库（studio 校验 source sha 与页码） */
export async function confirmTemplateKnowledge(folderId, candidateId, confirmedBy) {
  const dir = path.join(TPL_ROOT(), folderId);
  const manifest = await readJson(path.join(dir, 'manifest.json'), null);
  const list = await readJson(path.join(dir, 'knowledge-candidates.json'), null);
  if (!manifest || !list) throw apiError('SOURCE_NOT_FOUND', '模板不存在：' + folderId);
  const cand = list.find((c) => c.id === candidateId);
  if (!cand) throw apiError('SOURCE_NOT_FOUND', '候选不存在：' + candidateId);
  if (cand.status === 'confirmed') throw apiError('INVALID_OPERATION', '该候选已确认入库');
  if (!cand.text || !cand.text.trim()) throw apiError('INVALID_OPERATION', '候选内容为空，不能入库');
  const item = {
    text: cand.text,
    source_file: path.join(dir, 'reference.pptx'),
    source_sha256: manifest.source_sha256,
    slide: cand.slide,
    scope: cand.scope || ('template:' + folderId),
    fact_date: nowIso().slice(0, 10),
    time_sensitive: false,
  };
  const tmp = path.join(config().dataDir, 'cache', 'knowledge-item-' + Date.now().toString(36) + '.json');
  await writeJson(tmp, item);
  try {
    await studioRun(['knowledge', '--library', LIB(), '--item', tmp, '--confirmed-by', confirmedBy || '用户'], { timeoutMs: 60000 });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  cand.status = 'confirmed';
  cand.confirmed_at = nowIso();
  await writeJson(path.join(dir, 'knowledge-candidates.json'), list);
  return { id: candidateId, status: 'confirmed' };
}

/** 已入库知识（模板级） */
export async function listKnowledge() {
  const dir = path.join(LIB(), 'knowledge');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of (await fsp.readdir(dir)).filter((x) => x.endsWith('.json'))) {
    const j = await readJson(path.join(dir, f), null);
    if (j) out.push({ id: j.id, text: j.text, scope: j.scope, slide: j.slide, source_sha256: j.source_sha256, confirmed_by: j.confirmation && j.confirmation.confirmed_by, at: j.confirmation && j.confirmation.at });
  }
  return out;
}

/* ── 材料级事实（非 PPTX 源，自管理） ── */

export async function addMaterialFact(projectId, { text, source_name, locator }) {
  if (!text || !String(text).trim()) throw apiError('REQUIRED_FIELD_MISSING', '事实内容不能为空');
  const list = await readJson(path.join(projectDir(projectId), 'knowledge-facts.json'), []);
  const entry = {
    id: 'fact-' + Date.now().toString(36),
    text: String(text).trim().slice(0, 500),
    source_name: String(source_name || '对话补充').slice(0, 80),
    locator: String(locator || '').slice(0, 80),
    status: 'candidate',
    added_at: nowIso(),
  };
  list.push(entry);
  await writeJson(path.join(projectDir(projectId), 'knowledge-facts.json'), list);
  return entry;
}

export async function listMaterialFacts(projectId) {
  return readJson(path.join(projectDir(projectId), 'knowledge-facts.json'), []);
}

export async function confirmMaterialFact(projectId, factId, confirmedBy) {
  const list = await readJson(path.join(projectDir(projectId), 'knowledge-facts.json'), []);
  const fact = list.find((f) => f.id === factId);
  if (!fact) throw apiError('SOURCE_NOT_FOUND', '事实候选不存在：' + factId);
  if (fact.status === 'confirmed') throw apiError('INVALID_OPERATION', '该事实已确认');
  fact.status = 'confirmed';
  fact.confirmed_by = confirmedBy || '用户';
  fact.confirmed_at = nowIso();
  await writeJson(path.join(projectDir(projectId), 'knowledge-facts.json'), list);
  const lib = path.join(LIB(), 'material-knowledge.json');
  const store = await readJson(lib, []);
  if (!store.some((x) => x.project_id === projectId && x.id === fact.id)) {
    store.push({ ...fact, project_id: projectId });
    await writeJson(lib, store);
  }
  return fact;
}
