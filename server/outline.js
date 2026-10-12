/**
 * 汇文 PPT 后端 · 逐页大纲 outline（server/outline.js，WF-03）
 * outline.json：{ pages: [{ n, title, purpose, key_points, evidence, relation }],
 *                 approvals: { outline: {confirmed_by, note, at} }, revisions: [...] }
 * relation 是版式关系词（与模板库 layouts[].relation 对应），用于 WF-05 版式推荐。
 */

import path from 'node:path';
import { readJson, writeJson, nowIso } from './util.js';
import { projectDir } from './projects.js';

export async function loadOutline(id) {
  return readJson(path.join(projectDir(id), 'outline.json'), null);
}

export async function saveOutlineDraft(id, pages, meta = {}) {
  const cur = await loadOutline(id);
  const next = {
    pages: (pages || []).map((p, i) => ({
      n: i + 1,
      title: String(p.title || '未命名页').slice(0, 60),
      purpose: String(p.purpose || '').slice(0, 200),
      key_points: Array.isArray(p.key_points) ? p.key_points.map((k) => String(k).slice(0, 160)).slice(0, 6) : [],
      evidence: String(p.evidence || '').slice(0, 200),
      relation: String(p.relation || p.rel || '内容页').slice(0, 24),
    })),
    approvals: (cur && cur.approvals) || {},
    revisions: [...((cur && cur.revisions) || []), { at: nowIso(), source: meta.source || 'draft', count: (pages || []).length }],
    updated_at: nowIso(),
  };
  await writeJson(path.join(projectDir(id), 'outline.json'), next);
  return next;
}

/** 应用调整（LLM 或规则引擎产出的差异） */
export async function applyOutlineChanges(id, changes) {
  const cur = await loadOutline(id);
  if (!cur) {
    const e = new Error('尚无大纲草稿可调整');
    e.code = 'INVALID_OPERATION';
    throw e;
  }
  const pages = cur.pages.map((p) => ({ ...p }));
  const applied = [];
  for (const ch of Array.isArray(changes) ? changes : []) {
    const op = ch.op;
    if (op === 'add') {
      const at = Math.max(0, Math.min(pages.length, Number(ch.after || pages.length)));
      pages.splice(at, 0, { n: 0, title: ch.title || '新增页', purpose: ch.purpose || '', key_points: [], evidence: '', relation: ch.relation || '内容页' });
      applied.push({ op, at });
    } else if (op === 'remove') {
      const idx = Number(ch.index) - 1;
      if (idx >= 0 && idx < pages.length) { pages.splice(idx, 1); applied.push({ op, index: ch.index }); }
    } else if (op === 'move') {
      const from = Number(ch.from) - 1, to = Math.max(0, Math.min(pages.length - 1, Number(ch.to) - 1));
      if (from >= 0 && from < pages.length && from !== to) {
        const [m] = pages.splice(from, 1);
        pages.splice(to, 0, m);
        applied.push({ op, from: ch.from, to: ch.to });
      }
    } else if (op === 'update') {
      const idx = Number(ch.index) - 1;
      if (idx >= 0 && idx < pages.length) {
        const p = pages[idx];
        if (ch.title) p.title = String(ch.title).slice(0, 60);
        if (ch.purpose) p.purpose = String(ch.purpose).slice(0, 200);
        if (ch.relation) p.relation = String(ch.relation).slice(0, 24);
        applied.push({ op, index: ch.index });
      }
    }
  }
  const renumbered = pages.map((p, i) => ({ ...p, n: i + 1 }));
  const next = await saveOutlineDraft(id, renumbered, { source: 'adjust' });
  return { outline: next, applied };
}

/** 确认大纲（门禁） */
export async function confirmOutline(id, confirmedBy, note) {
  const cur = await loadOutline(id);
  if (!cur || !cur.pages || !cur.pages.length) {
    const e = new Error('尚无可确认的大纲');
    e.code = 'REQUIRED_FIELD_MISSING';
    throw e;
  }
  const next = {
    ...cur,
    approvals: { ...(cur.approvals || {}), outline: { confirmed_by: confirmedBy || '用户', note: note || '对话确认逐页大纲', at: nowIso() } },
    updated_at: nowIso(),
  };
  await writeJson(path.join(projectDir(id), 'outline.json'), next);
  return next;
}

/** outline → 客户端卡片形状 [{n,title,rel}] */
export function outlineCardPayload(outline) {
  return (outline.pages || []).map((p) => ({ n: p.n, title: p.title, rel: p.relation }));
}
