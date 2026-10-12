/**
 * 汇文 PPT 后端 · 导出与归档（server/exporter.js，WF-08）
 * 导出 = 当前版本复制到工作区 exports/ 并登记（exports.json）→ 项目闭环归档（只读、版本定格）。
 * 下载路由带 content-disposition，浏览器直取；重新打开解除只读（既有 /reopen）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { readJson, writeJson, sha256File, nowIso, apiError } from './util.js';

export async function exportsRegistry(projectId) {
  return readJson(path.join(projectDir(projectId), 'exports.json'), []);
}

/** 导出当前版本 → exports/<project-id>/ 并归档项目 */
export async function exportProject(projectId, { note = '' } = {}) {
  const { meta } = await loadProject(projectId);
  if (meta.status === 'archived') throw apiError('INVALID_OPERATION', '项目已归档，先重新打开再导出新版本');
  if (!meta.version || !meta.source_name || !meta.source_sha256) {
    throw apiError('INVALID_OPERATION', '尚无可导出的版本，先生成（WF-06）');
  }
  const src = path.join(projectDir(projectId), 'versions', meta.source_name);
  if (!fs.existsSync(src)) throw apiError('SOURCE_NOT_FOUND', '版本文件缺失：' + meta.source_name);
  const outDir = path.join(config().dataDir, 'exports', projectId);
  await fsp.mkdir(outDir, { recursive: true });
  const exportName = meta.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40) + '_' + meta.version + '.pptx';
  const target = path.join(outDir, exportName);
  await fsp.copyFile(src, target);
  const sha = await sha256File(target);
  const list = await exportsRegistry(projectId);
  const entry = {
    id: 'exp-' + Date.now().toString(36),
    version: meta.version,
    file: path.join('exports', projectId, exportName),
    download_name: exportName,
    sha256: sha,
    note: note || '',
    exported_at: nowIso(),
  };
  if (!list.some((e) => e.sha256 === entry.sha256)) {
    list.push(entry);
    await writeJson(path.join(projectDir(projectId), 'exports.json'), list);
  }
  // 导出即闭环归档（WF-08）：版本定格、只读；visual_review 待 WPS 验收，导出视为用户验收
  await updateProjectMeta(projectId, {
    status: 'archived',
    archived_at: nowIso(),
    next_action: null,
    checks: { ...(meta.checks || {}), user_acceptance: 'pass' },
  });
  return { ...entry, archived: true };
}

/** 下载响应（attachment） */
export async function downloadVersion(projectId) {
  const { meta } = await loadProject(projectId);
  if (!meta.source_name) throw apiError('INVALID_OPERATION', '尚无可下载的版本');
  const src = path.join(projectDir(projectId), 'versions', meta.source_name);
  if (!fs.existsSync(src)) throw apiError('SOURCE_NOT_FOUND', '版本文件缺失：' + meta.source_name);
  const name = (meta.title || meta.id).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40) + '_' + (meta.version || 'v0001') + '.pptx';
  return { path: src, name };
}
