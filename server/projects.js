/**
 * 汇文 PPT 后端 · 项目域（server/projects.js）
 * 目录契约（沿用 studio.py 约定）：
 *   projects/<id>/reference.pptx          只读源（始终保留）
 *   projects/<id>/versions/revision-NNN.pptx
 *   projects/<id>/state.json              studio 状态（revision/current/current_sha256/renders）
 *   projects/<id>/project.json            插件扩展状态（title/stage/checks/style_selection/...）
 *   projects/<id>/inspection.json         结构检查（对象边界、可编辑性）
 *   projects/<id>/brief.json / outline.json / plan.json / materials.json / conversation.jsonl ...
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, subdir } from './config.js';
import { readJson, writeJson, sha256File, nowIso, nowLocal, shortSha } from './util.js';
import { createProject, inspectSource } from './studio.js';
import { withProjectLock } from './workflow.js';
import { listJobs, cancelProjectJobs } from './jobs.js';

export function projectsRoot() {
  return subdir('projects');
}

export function projectDir(id) {
  const p = path.join(projectsRoot(), id);
  if (!p.startsWith(projectsRoot() + path.sep)) {
    const e = new Error('非法项目 ID');
    e.code = 'INVALID_OPERATION';
    throw e;
  }
  return p;
}

export async function projectExists(id) {
  return fs.existsSync(path.join(projectDir(id), 'project.json'));
}

export async function loadProject(id) {
  const dir = projectDir(id);
  const meta = await readJson(path.join(dir, 'project.json'), null);
  if (!meta) {
    const e = new Error('项目不存在：' + id);
    e.code = 'SOURCE_NOT_FOUND';
    e.recoverable = false;
    throw e;
  }
  const state = await readJson(path.join(dir, 'state.json'), {});
  // project.json is the atomic commit pointer; state.json also serves the standalone engine.
  if (meta.version && meta.source_name) Object.assign(state,{current:'versions/'+meta.source_name,current_sha256:meta.source_sha256,revision:Number(meta.version.slice(1))});
  else if (meta.origin==='conversation') Object.assign(state,{current:null,current_sha256:null,revision:0});
  return { id, dir, meta, state };
}

async function saveProjectMeta(id, meta) {
  await writeJson(path.join(projectDir(id), 'project.json'), meta);
}

/** 生成项目 ID：project-YYYYMMDD-NNN */
async function nextProjectId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
  let n = 1;
  const root = projectsRoot();
  const existing = new Set(fs.existsSync(root) ? await fsp.readdir(root) : []);
  // 复用已删除目录留下的空号，避免同日重复
  for (;;) {
    const id = `project-${day}-${String(n).padStart(3, '0')}`;
    if (!existing.has(id) && !fs.existsSync(path.join(config().dataDir, 'exports', id))) {
      try { await fsp.mkdir(path.join(root, id)); return id; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    n += 1;
  }
}

/**
 * 对话驱动项目（WF-02 主入口）：不来自 PPTX 源文件，
 * 先建项目壳（brief/outline/对话流），首个版本在 WF-06 构建时产生。
 */
export async function createConversationProject(title) {
  const id = await nextProjectId();
  const dir = projectDir(id);
  await fsp.mkdir(path.join(dir, 'versions'), { recursive: true });
  const meta = {
    id,
    title: title || '未命名汇报',
    status: 'active',
    stage: 'idle',
    origin: 'conversation',
    created_at: nowIso(),
    updated_at: nowIso(),
    source_name: null,
    source_sha256: null,
    page_count: 0,
    style_selection: null,
    checks: { structural: 'pending', render: 'pending', visual_review: 'pending', editability: 'pending', user_acceptance: 'pending' },
    next_action: '在对话中确认需求与材料',
  };
  await saveProjectMeta(id, meta);
  await writeJson(path.join(dir, 'annotations.json'), []);
  return { id, meta };
}

/**
 * 从服务器本地文件导入创建项目（WF-01）。
 * 上传走 importFromBuffer；本地路径导入用于测试与既有文件接驳。
 */
export async function importFromPath(absPath, title) {
  if (!fs.existsSync(absPath)) {
    const e = new Error('源文件不存在：' + absPath);
    e.code = 'SOURCE_NOT_FOUND';
    e.recoverable = false;
    throw e;
  }
  const lower = String(absPath).toLowerCase();
  if (!lower.endsWith('.pptx') && !lower.endsWith('.potx')) {
    const e = new Error('仅支持 .pptx / .potx 源文件');
    e.code = 'INVALID_OPERATION';
    throw e;
  }
  const id = await nextProjectId();
  const dir = projectDir(id);
  try {
  const created = await createProject(absPath, dir); // studio: reference.pptx + versions/revision-000.pptx + state.json + annotations.json
  const inspectionPath = path.join(dir, 'inspection.json');
  await inspectSource(path.join(dir, 'reference.pptx'), inspectionPath);
  const inspection = await readJson(inspectionPath, {});
  const sha = await sha256File(path.join(dir, 'reference.pptx'));
  const meta = {
    id,
    title: title || path.basename(absPath).replace(/\.[^.]+$/, ''),
    status: 'active',
    stage: 'imported',
    created_at: nowIso(),
    updated_at: nowIso(),
    source_name: path.basename(absPath),
    source_sha256: sha,
    page_count: (inspection.slides || []).length,
    style_selection: null,
    checks: { structural: 'pass', render: 'pending', visual_review: 'pending', editability: 'pending', user_acceptance: 'pending' },
    next_action: '进入对话制作或直接打开画布',
  };
  await saveProjectMeta(id, meta);
  const { finalizeVersion }=await import('./generate.js');
  await finalizeVersion(id,path.join(dir,'versions','revision-000.pptx'),{phase:'import',label:'v0000',file:'revision-000.pptx',expectedSlides:meta.page_count});
  const loaded=await loadProject(id);
  return { id, meta:loaded.meta, state:loaded.state };
  } catch(e) {await fsp.rm(dir,{recursive:true,force:true});throw e;}
}

/** 从上传 Buffer 创建项目（WF-01 主路径） */
export async function importFromBuffer(buf, filename, title) {
  if (!/\.(pptx|potx)$/i.test(String(filename || ''))) {
    const e = new Error('仅支持 .pptx / .potx 源文件');
    e.code = 'INVALID_OPERATION';
    throw e;
  }
  const staged = path.join(config().dataDir, 'cache', 'upload-' + (await import('node:crypto')).randomUUID() + path.extname(filename));
  await fsp.mkdir(path.dirname(staged), { recursive: true });
  await fsp.writeFile(staged, buf);
  try {
    const r = await importFromPath(staged, title || String(filename).replace(/\.[^.]+$/, ''));
    await updateProjectMeta(r.id, { original_filename: filename });
    return loadProject(r.id).then((p) => ({ id: r.id, meta: p.meta, state: p.state }));
  } finally {
    await fsp.rm(staged, { force: true }).catch(() => {});
  }
}

/** 项目卡片（客户端首页形状） */
export async function listProjectCards() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const cards = [];
  for (const name of (await fsp.readdir(root)).sort()) {
    const meta = await readJson(path.join(root, name, 'project.json'), null);
    if (!meta) continue;
    const state = await readJson(path.join(root, name, 'state.json'), {});
    cards.push({
      id: meta.id,
      title: meta.title,
      file: state.current || null,
      pages: meta.page_count || 0,
      sha256: shortSha(state.current_sha256 || meta.source_sha256 || ''),
      style: meta.style_selection?.primary || null,
      engine: 'LibreOffice ' + ((meta.last_render_engine_version) || ''),
      status: meta.status === 'archived' ? 'archived' : (meta.stage || 'draft'),
      lifecycle_status: meta.status,
      status_label: statusLabel(meta),
      version: meta.version || ('r' + String(state.revision ?? 0).padStart(3, '0')),
      updated: (meta.updated_at || meta.created_at || '').slice(0, 16).replace('T', ' '),
      next_action: meta.next_action || '',
      checks: meta.checks || {},
      archived: meta.status === 'archived',
      read_only: meta.status === 'archived',
    });
  }
  return cards.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

function statusLabel(meta) {
  if (meta.status === 'archived') return '已归档';
  const map = {
    imported: '已导入',
    material: '需求与材料',
    outline: '大纲确认中',
    style: '风格选择中',
    pages: '逐页版式中',
    generating: '生成中',
    done: '已完成',
    render_failed: '渲染失败',
    pending_review: '待审阅',
  };
  return map[meta.stage] || meta.stage || '草稿';
}

/** 项目状态轻量读取（画布/对话轮询用） */
export async function projectState(id) {
  const { dir, meta, state } = await loadProject(id);
  return {
    id,
    meta,
    studio_state: state,
    state_revision: meta.state_revision || 1,
  };
}

/** 更新扩展状态（stage/checks/...），带乐观锁 */
export async function updateProjectMeta(id, patch, expectedRevision) {
  return withProjectLock(id, async () => {
  const { meta } = await loadProject(id);
  if (expectedRevision != null && (meta.state_revision || 1) !== expectedRevision) {
    const e = new Error('项目状态已被其他操作更新，请刷新后重试');
    e.code = 'STATE_REVISION_CONFLICT';
    e.details = { expected: expectedRevision, actual: meta.state_revision || 1 };
    throw e;
  }
  const next = { ...meta, ...patch, state_revision: (meta.state_revision || 1) + 1, updated_at: nowIso() };
  await saveProjectMeta(id, next);
  return next;
  });
}

export async function projectSnapshot(id) {
  const readSnapshot = async () => {
    const { dir, meta, state } = await loadProject(id);
    const snapshot = { id, meta, studio_state: state, jobs: listJobs(id) };
    for (const [key, file] of Object.entries({ brief: 'brief.json', outline: 'outline.json', materials: 'materials.json', custom_style: 'custom-style.json', selection: 'style-selection.json', plan: 'plan.json', annotations: 'annotations.json', preferences: 'layout-preferences.json' })) snapshot[key] = await readJson(path.join(dir, file), null);
    if (snapshot.materials) snapshot.materials = await (await import('./materials.js')).listMaterials(id);
    snapshot.report = meta.latest_report ? await readJson(path.join(dir, meta.latest_report), null) : null;
    snapshot.renders = snapshot.report?.render_pngs || [];
    return snapshot;
  };
  for (let attempt=0;attempt<3;attempt++) {
    const snapshot=await readSnapshot();
    const {meta}=await loadProject(id);
    if(meta.state_revision===snapshot.meta.state_revision) return snapshot;
  }
  throw Object.assign(new Error('项目正在更新，请重新读取快照'),{code:'STATE_REVISION_CONFLICT'});
}

export async function deleteProject(id) {
  await cancelProjectJobs(id);
  return withProjectLock(id, async () => {
    await loadProject(id);
    await fsp.rm(projectDir(id), { recursive: true, force: true });
    await fsp.rm(path.join(config().dataDir, 'exports', id), { recursive: true, force: true });
    const lib = path.join(config().dataDir, 'library', 'material-knowledge.json');
    await writeJson(lib, (await readJson(lib, [])).filter((f) => f.project_id !== id));
    return { deleted: id };
  });
}

/** 版本列表 */
export async function listVersions(id) {
  const { dir, state } = await loadProject(id);
  const vdir = path.join(dir, 'versions');
  const files = fs.existsSync(vdir) ? (await fsp.readdir(vdir)).filter((f) => f.endsWith('.pptx')).sort() : [];
  return {
    current: state.current,
    current_sha256: state.current_sha256,
    revision: state.revision,
    versions: await Promise.all(files.map(async (f) => ({
      file: 'versions/' + f,
      sha256: await sha256File(path.join(vdir, f)),
      mtime: (await fsp.stat(path.join(vdir, f))).mtime.toISOString(),
    }))),
  };
}
