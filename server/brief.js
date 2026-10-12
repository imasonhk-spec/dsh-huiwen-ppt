/**
 * 汇文 PPT 后端 · 需求摘要 brief（server/brief.js，WF-02）
 * brief.json：{ title, audience, scenario, key_message, page_count, material_policy,
 *               duration, notes, approvals: { requirements: {confirmed_by, note, at} } }
 */

import path from 'node:path';
import { readJson, writeJson, nowIso } from './util.js';
import { projectDir } from './projects.js';

export async function loadBrief(id) {
  return readJson(path.join(projectDir(id), 'brief.json'), null);
}

export async function saveBriefDraft(id, patch) {
  const cur = (await loadBrief(id)) || {};
  const next = { ...cur, ...patch, updated_at: nowIso() };
  if (next.approvals && typeof next.approvals !== 'object') delete next.approvals;
  await writeJson(path.join(projectDir(id), 'brief.json'), next);
  return next;
}

/** 确认需求（门禁：需求摘要确认后才可进大纲/构建） */
export async function confirmBrief(id, confirmedBy, note) {
  const cur = (await loadBrief(id)) || {};
  if (!cur.title) {
    const e = new Error('需求摘要缺少标题，先在对话中补全再确认');
    e.code = 'REQUIRED_FIELD_MISSING';
    e.details = { missing: ['title'] };
    throw e;
  }
  const next = {
    ...cur,
    approvals: { ...(cur.approvals || {}), requirements: { confirmed_by: confirmedBy || '用户', note: note || '对话确认', at: nowIso() } },
    updated_at: nowIso(),
  };
  await writeJson(path.join(projectDir(id), 'brief.json'), next);
  return next;
}

export function briefSummary(brief) {
  if (!brief) return null;
  return {
    title: brief.title || null,
    audience: brief.audience || null,
    scenario: brief.scenario || null,
    key_message: brief.key_message || null,
    page_count: brief.page_count || null,
    material_policy: brief.material_policy || null,
    style_preference: brief.style_preference || null,
    duration: brief.duration || null,
    confirmed: Boolean(brief.approvals && brief.approvals.requirements),
  };
}
