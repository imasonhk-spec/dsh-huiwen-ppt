/**
 * 汇文 PPT 后端 · API 路由（server/router.js）
 * 挂载在 /api/huiwen-ppt 之下（index.js 完成认证门禁后转交）。
 * 错误信封统一方案 §13：{ ok, code, message, details, recoverable, next_actions }。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, subdir, updateConfig } from './config.js';
import { readJsonBody, readBody, readJson, safeJoin, apiError, nowIso, stableHash } from './util.js';
import { engineMatrix } from './engines.js';
import { buildIndex, cachedIndex, invalidateIndex } from './index-builder.js';
import { resolveModel } from './llm.js';
import { getDshLocalModels, probeProvider } from './dsh-models.js';
import * as projects from './projects.js';
import * as dialogue from './dialogue.js';
import * as briefs from './brief.js';
import * as outlines from './outline.js';
import * as materials from './materials.js';
import * as planner from './planner.js';
import * as generate from './generate.js';
import * as revise from './revise.js';
import * as exporter from './exporter.js';
import * as knowledge from './knowledge.js';
import { getJob as getJobById, requestCancel as cancelJobById, cancelProjectJobs, listJobs } from './jobs.js';
import { VERSION } from './meta.js';
import { inputFingerprint, planFingerprint } from './dependencies.js';
import * as editor from './editor.js';
import { withProjectLock } from './workflow.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const STATUS_BY_CODE = {
  SOURCE_NOT_FOUND: 404,
  SOURCE_HASH_MISMATCH: 409,
  FORBIDDEN: 403,
  STATE_REVISION_CONFLICT: 409,
  REQUEST_CONFLICT: 409,
  REQUEST_DELETED: 409,
  VERSION_CONFLICT: 409,
  SOURCE_CHANGED: 409,
  DELIVERY_BLOCKED: 409,
  ANNOTATION_VERSION_MISMATCH: 409,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_OPERATION: 400,
  REQUIRED_FIELD_MISSING: 400,
  UNSUPPORTED_OBJECT: 400,
  KNOWLEDGE_SOURCE_MISSING: 400,
  TEMPLATE_NOT_APPROVED: 409,
  TEMPLATE_SELECTION_REQUIRED: 409,
  JOB_CANCELLED: 409,
  ENGINE_UNAVAILABLE: 503,
  RENDER_FAILED: 500,
};

function fail(res, e) {
  const status = STATUS_BY_CODE[e.code] || 500;
  sendJson(res, status, apiError(e.code || 'INTERNAL', e.message, e.details, e.recoverable !== false, e.next_actions || []));
}

function jobViewOf(job) {
  return {
    id: job.id, type: job.type, project_id: job.project_id, status: job.status,
    step: job.step, progress: job.progress, result: job.result, error: job.error,
    created_at: job.created_at, updated_at: job.updated_at,
    completed_pages:job.completed_pages,total_pages:job.total_pages,
  };
}

function stateRevision() {
  // 资源索引版本即全局状态版本（对话/画布并发控制逐批启用）
  return (cachedIndex() || {}).index_revision || 'boot';
}

/* ── 路由表 ───────────────────────────────────────────────────── */

const routes = [];
function route(method, pattern, handler) {
  // pattern: '/projects/:id/state' → regex
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z_]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, rx, keys, handler });
}

/* ── 0.3.4.1：无卡点动作链——动作在任何阶段触发都自动补齐前置（缺标题就补、缺大纲就生成、
   未确认就自动确认、缺风格用默认/偏好、缺计划就构建），绝不把流程门禁错误抛给用户 ── */
async function ensureActionReady(projectId, upTo) {
  const auto = [];
  let brief = await briefs.loadBrief(projectId);
  if (!brief || !brief.title) {
    brief = await briefs.saveBriefDraft(projectId, { title: '未命名汇报' });
  }
  if (!brief.approvals || !brief.approvals.requirements) {
    await dialogue.ensureBriefApproved(projectId, '用户动作', '动作触发自动确认（无卡点链）');
    auto.push('需求确认');
  }
  let outline = await outlines.loadOutline(projectId);
  if (!outline || !(outline.pages || []).length || outline.input_fingerprint !== await inputFingerprint(projectId)) {
    await dialogue.generateOutlineForProject(projectId, null, '（按你的动作先自动补了一份大纲，可随时说调整或推翻重来）：');
    outline = await outlines.loadOutline(projectId);
    auto.push('生成大纲');
  }
  if (!outline.approvals || !outline.approvals.outline) {
    await outlines.confirmOutline(projectId, '用户动作', '动作触发自动确认（无卡点链）');
    auto.push('大纲确认');
  }
  if (upTo === 'outline') return auto;
  let sel = await planner.getStyleSelection(projectId);
  const latestBrief = await briefs.loadBrief(projectId);
  if (sel && latestBrief?.page_count && sel.count !== latestBrief.page_count) sel = await planner.selectStyle(projectId,{family:sel.family,count:latestBrief.page_count});
  if (!sel) {
    await projects.updateProjectMeta(projectId,{stage:'style',next_action:'请确认模板主题与页数'});
    throw apiError('TEMPLATE_SELECTION_REQUIRED','请先确认模板主题与页数，再开始生成',{stage:'style',count:outline.pages.length});
  }
  if (upTo === 'style') return auto;
  const currentPlan = await planner.getPlan(projectId);
  if (!currentPlan || currentPlan.input_fingerprint !== await planFingerprint(projectId)) {
    await planner.buildPlan(projectId, {});
    auto.push('执行计划');
  }
  return auto;
}

/* ── WF-00：能力 / 状态 / 资源索引 ───────────────────────────── */

route('GET', '/status', async (ctx) => {
  sendJson(ctx.res, 200, {
    ok: true, plugin: 'huiwen-ppt', version: VERSION, backend: 'connected',
    index_revision: stateRevision(), data_dir: config().dataDir, time: nowIso(),
  });
});

route('GET', '/capabilities', async (ctx) => {
  const index = await buildIndex();
  const engines = await engineMatrix();
  sendJson(ctx.res, 200, {
    ok: true, version: VERSION, prototype: false,
    index_revision: index.index_revision,
    workflows: Array.from({length:11},(_,i)=>'WF-'+String(i).padStart(2,'0')),
    engines,
    data_dir: config().dataDir,
    limits: config().limits,
  });
});

route('GET', '/data', async (ctx) => {
  const index = await buildIndex();
  sendJson(ctx.res, 200, { ...index, backend: 'connected', account_scope: stableHash(config().dataDir).slice(0,24), state_revision: index.index_revision });
});

route('GET', '/styles', async (ctx) => {
  const index = await buildIndex();
  sendJson(ctx.res, 200, { ok: true, styles: index.styles });
});

route('GET', '/engines', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, engines: await engineMatrix(ctx.query.get('force') === '1') });
});
route('GET','/render-config',async(ctx)=>{const render=config().render;sendJson(ctx.res,200,{ok:true,render:{...render,remote:{url:render.remote?.url||'',configured:!!render.remote?.token}}});});
route('POST','/render-config',async(ctx)=>{const body=await readJsonBody(ctx.req);if(!['libreoffice','wps','powerpoint'].includes(body.engine))throw apiError('INVALID_OPERATION','渲染引擎无效');await updateConfig({render:{engine:body.engine,remote:{url:body.url??config().render.remote.url,token:body.token??config().render.remote.token}}});sendJson(ctx.res,200,{ok:true,engines:await engineMatrix(true)});});

route('GET', '/models', async (ctx) => {
  const cfg = config().ollama;
  const withHealth = [];
  // 1) huiwen 专用模型（Ollama 原生）
  for (const m of cfg.models) {
    const r = await resolveModel(m.id);
    withHealth.push({ id: r.id, label: r.label, tag: r.tag, desc: r.desc, online: r.online, reason: r.reason, group: 'huiwen 专用' });
  }
  // 2) DSH 同步模型（本地 provider，OpenAI-compatible；自动跟随 cordis.patch.yml）
  try {
    const dshProviders = await getDshLocalModels();
    for (const p of dshProviders) {
      const probe = await probeProvider(p.baseURL, p.headers);
      const group = 'DSH · ' + p.displayName;
      for (const m of p.models) {
        withHealth.push({
          id: m.id, label: m.label, tag: m.rawId,
          desc: 'DSH 同步 · ' + p.displayName + (m.contextWindow ? ` · ${Math.round(m.contextWindow / 1024)}K` : ''),
          online: probe.ok, reason: probe.reason, group,
        });
      }
    }
  } catch { /* DSH 模型同步失败不阻塞 huiwen 模型返回 */ }
  sendJson(ctx.res, 200, { ok: true, default: cfg.defaultModelId, models: withHealth });
});

/* ── WF-09：模板库 / 素材 ────────────────────────────────────── */

route('GET', '/templates', async (ctx) => {
  const index = await buildIndex();
  const q = (ctx.query.get('query') || '').trim().toLowerCase();
  const family = ctx.query.get('family');
  const relation = ctx.query.get('relation');
  const approval = ctx.query.get('approval');
  let list = index.layouts;
  if (q) list = list.filter((l) => [l.id, l.name, l.composition, ...(l.tags || [])].join(' ').toLowerCase().includes(q));
  if (family) list = list.filter((l) => l.family === family);
  if (relation) list = list.filter((l) => l.relation === relation || (l.tags || []).includes(relation));
  if (approval) list = list.filter((l) => l.approval === approval);
  sendJson(ctx.res, 200, { ok: true, index_revision: index.index_revision, total: list.length, layouts: list });
});

route('GET', '/templates/:id', async (ctx) => {
  const index = await buildIndex();
  const lay = index.layouts.find((l) => l.id === ctx.params.id);
  if (!lay) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '版式不存在：' + ctx.params.id, null, false));
  const assets = index.assets.filter((a) => (lay.asset_ids || []).includes(a.id));
  sendJson(ctx.res, 200, { ok: true, layout: lay, assets });
});

route('POST', '/templates/compare', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const index = await buildIndex();
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 4) : [];
  const layouts = ids.map((id) => index.layouts.find((l) => l.id === id)).filter(Boolean);
  sendJson(ctx.res, 200, { ok: true, layouts });
});

route('POST', '/assets/search', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const index = await buildIndex();
  const q = String(body.query || '').trim().toLowerCase();
  const family = body.family;
  let list = index.assets;
  if (q) list = list.filter((a) => [a.id, a.name, a.usage, ...(a.tags || [])].join(' ').toLowerCase().includes(q));
  if (family) list = list.filter((a) => a.family === family);
  sendJson(ctx.res, 200, { ok: true, total: list.length, assets: list });
});

/* ── WF-01：项目 ─────────────────────────────────────────────── */

route('GET', '/projects', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, projects: await projects.listProjectCards() });
});

route('POST', '/projects/import', async (ctx) => {
  const filename = ctx.query.get('filename') || 'upload.pptx';
  const title = ctx.query.get('title') || null;
  const max = config().limits.uploadMaxBytes;
  const buf = await readBody(ctx.req, max);
  if (!buf.length) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '请求体为空：请以二进制流上传 PPTX'));
  const r = await projects.importFromBuffer(buf, filename, title);
  invalidateIndex();
  sendJson(ctx.res, 200, { ok: true, project: r.meta, state: r.state });
});

route('GET', '/projects/:id/state', async (ctx) => {
  const st = await projects.projectState(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true, ...st });
});
route('GET','/projects/:id/snapshot',async(ctx)=>sendJson(ctx.res,200,{ok:true,...await projects.projectSnapshot(ctx.params.id)}));
route('DELETE','/projects/:id',async(ctx)=>{ const result=await projects.deleteProject(ctx.params.id); invalidateIndex(); sendJson(ctx.res,200,{ok:true,...result}); });

route('GET', '/projects/:id/versions', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, ...(await projects.listVersions(ctx.params.id)) });
});

route('GET', '/projects/:id/inspection', async (ctx) => {
  const { dir, meta } = await projects.loadProject(ctx.params.id);
  const version = ctx.query.get('version') || meta.version;
  const insp = await readJson(path.join(dir, version ? 'inspection-'+version+'.json' : 'inspection.json'), null);
  if (!insp) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '尚未生成结构检查', { project: ctx.params.id }));
  sendJson(ctx.res, 200, { ok: true, inspection: insp });
});

route('POST', '/projects/:id/reopen', async (ctx) => {
  const { meta } = await projects.loadProject(ctx.params.id);
  // 方案 WF-08：重新打开 = 复制为可编辑工作版本（当前先解除只读并记录 reopen 次数）
  const next = await projects.updateProjectMeta(ctx.params.id, {
    status: 'active',
    reopen_count: (meta.reopen_count || 0) + 1,
    next_action: '继续制作或导出',
  });
  invalidateIndex();
  sendJson(ctx.res, 200, { ok: true, project: next });
});

route('POST', '/projects/:id/archive', async (ctx) => {
  const { meta } = await projects.loadProject(ctx.params.id);
  if (meta.status === 'archived') return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '项目已归档'));
  const next = await projects.updateProjectMeta(ctx.params.id, {
    status: 'archived',
    archived_at: nowIso(),
    next_action: '只读保留；可重新打开',
  });
  invalidateIndex();
  sendJson(ctx.res, 200, { ok: true, project: next });
});

/* ── WF-02：对话项目 / 对话流 / 材料 / brief ──────────────────── */

/** F4 重命名：会话名 = 项目名（W0 冻结契约）
 *  PATCH /api/huiwen-ppt/api/projects/:id/title
 *  body { title, expected_revision? } → 200 { ok:true, project:{ id, title, state_revision, title_source } }
 *  400 REQUIRED_FIELD_MISSING / INVALID_OPERATION、404 SOURCE_NOT_FOUND、409 STATE_REVISION_CONFLICT。
 *  ⚠️ 分发器的自动加锁只覆盖 POST/DELETE，PATCH 不会被自动套锁；而 updateProjectMeta 内部
 *  自带 withProjectLock + state_revision 乐观校验 → 此处直接调用，切勿再外套一层锁。
 *  标题即时生效：listProjectCards 每次实时读 project.json，buildIndex 非 force 也重取 projects
 *  → 不调 invalidateIndex()，避免全量重建。 */
route('PATCH', '/projects/:id/title', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  if (typeof body.title !== 'string') return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', 'title 必须为字符串', { field: 'title' }));
  const title = body.title.trim();
  if (!title) return sendJson(ctx.res, 400, apiError('REQUIRED_FIELD_MISSING', '项目名称不能为空', { missing: ['title'] }));
  if (title.length > 80) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '项目名称最长 80 个字符', { field: 'title', max: 80, actual: title.length }));
  let expected;
  if (body.expected_revision != null) {
    expected = Number(body.expected_revision);
    if (!Number.isInteger(expected)) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', 'expected_revision 必须为整数', { field: 'expected_revision' }));
  }
  const next = await projects.updateProjectMeta(ctx.params.id, { title, title_source: 'manual' }, expected);
  sendJson(ctx.res, 200, {
    ok: true,
    project: { id: next.id, title: next.title, state_revision: next.state_revision, title_source: next.title_source },
  });
});

route('POST', '/projects/new', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  if (typeof body.request_id!=='string' || !body.request_id) throw apiError('REQUIRED_FIELD_MISSING','新建对话需要稳定请求号');
  const r = await projects.createConversationProject(String(body.title || '').slice(0, 60) || null,{request_id:body.request_id,template_selection:body.template_selection});
  invalidateIndex();
  sendJson(ctx.res, 200, { ok: true, project: r.meta });
});

route('GET','/requests/:requestId',async(ctx)=>{
  const requestId=ctx.params.requestId;
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))throw apiError('INVALID_OPERATION','请求号无效');
  const receipt=await readJson(path.join(subdir('requests'),stableHash(requestId)+'.json'),null);
  if(!receipt)return sendJson(ctx.res,200,{ok:true,found:false});
  if(receipt.deleted)return sendJson(ctx.res,200,{ok:true,found:true,status:'deleted'});
  const loaded=await projects.loadProject(receipt.id).catch(e=>{if(e.code==='SOURCE_NOT_FOUND')return null;throw e;});
  const valid=loaded?.meta.creation_id===receipt.creation_id&&loaded?.meta.creation_request_id===requestId;
  sendJson(ctx.res,200,{ok:true,found:true,status:valid?'created':receipt.status==='reserved'?'reserved':'deleted',project:valid?loaded.meta:null});
});

route('GET','/projects/:id/request-receipts/:requestId',async(ctx)=>{
  await projects.loadProject(ctx.params.id);
  const requestId=ctx.params.requestId;
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))throw apiError('INVALID_OPERATION','请求号无效');
  const stored=await readJson(path.join(projects.projectDir(ctx.params.id),'message-requests.json'),{});
  const message=stored[requestId];
  const job=listJobs(ctx.params.id).find(j=>j.meta?.request_id===requestId);
  sendJson(ctx.res,200,{ok:true,found:!!(message||job),result:message?.result||null,job:job?jobViewOf(job):null});
});

route('GET', '/projects/:id/conversation', async (ctx) => {
  const conv = await dialogue.getConversation(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true, ...conv });
});

route('POST', '/projects/:id/reset', async (ctx) => {
  const r = await dialogue.resetProject(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true, stage: r.stage, messages: r.messages });
});

route('POST', '/projects/:id/conversation/message', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const text = String(body.text || '').trim();
  const r = await dialogue.handleProductionMessage(ctx.params.id, text, {message_id:body.message_id,model_id:body.model_id || null});
  const st2 = await projects.projectState(ctx.params.id);
  sendJson(ctx.res, r.error ? 503 : 200, { ok: !r.error, ...r, ...(r.error || {}), state_revision: st2.state_revision });
});

route('POST', '/projects/:id/outline/generate', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const r = await dialogue.generateOutlineForProject(ctx.params.id, body.model_id || null, '需求已经清楚了，我拟了一份大纲：');
  sendJson(ctx.res, 200, { ok: true, ...r });
});

route('POST', '/projects/:id/outline/adjust', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const instruction = String(body.instruction || body.text || '').trim();
  if (!instruction) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '调整指令不能为空'));
  const r = await dialogue.handleMessage(ctx.params.id, instruction, body.model_id || null, '用户');
  sendJson(ctx.res, r.error ? 503 : 200, { ok: !r.error, ...r, ...(r.error || {}) });
});

route('POST', '/projects/:id/outline/confirm', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  await ensureActionReady(ctx.params.id, 'outline'); // 0.3.4.1：无大纲/未确认自动补齐（无卡点链），不再报 WF-03
  const o = await outlines.confirmOutline(ctx.params.id, body.confirmed_by || '用户', body.note || '卡片确认逐页大纲');
  await projects.updateProjectMeta(ctx.params.id, { stage: 'style', next_action: '选择风格与页数' });
  sendJson(ctx.res, 200, { ok: true, outline: o, stage: 'style' });
});

route('GET', '/projects/:id/outline', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, outline: await outlines.loadOutline(ctx.params.id) });
});

route('POST', '/projects/:id/brief/confirm', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const b = await briefs.confirmBrief(ctx.params.id, body.confirmed_by || '用户', body.note || '卡片确认需求摘要');
  sendJson(ctx.res, 200, { ok: true, brief: b });
});

route('POST','/projects/:id/model',async(ctx)=>{
  const body=await readJsonBody(ctx.req);
  const model=await resolveModel(body.model_id);
  if(model.id!==body.model_id) throw apiError('INVALID_OPERATION','请选择已登记模型');
  await projects.updateProjectMeta(ctx.params.id,{dialogue_model:model.id});
  sendJson(ctx.res,200,{ok:true,model_id:model.id});
});

route('GET', '/projects/:id/brief', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, brief: await briefs.loadBrief(ctx.params.id) });
});

route('POST', '/projects/:id/materials', async (ctx) => {
  const filename = ctx.query.get('filename') || 'material.bin';
  const max = config().limits.uploadMaxBytes;
  const buf = await readBody(ctx.req, max);
  if (!buf.length) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '材料内容为空'));
  const r = await materials.addMaterial(ctx.params.id, buf, filename);
  sendJson(ctx.res, 200, { ok: true, ...r });
});

route('GET', '/projects/:id/materials', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, materials: await materials.listMaterials(ctx.params.id) });
});

route('DELETE', '/projects/:id/materials/:mid', async (ctx) => {
  const entry = await materials.removeMaterial(ctx.params.id, ctx.params.mid);
  if (!entry) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '材料不存在：' + ctx.params.mid));
  sendJson(ctx.res, 200, { ok: true, removed: entry.id });
});

/* ── WF-04：风格选择 / 自定义模板；WF-05：执行计划 ────────────── */

route('POST', '/projects/:id/style/template', async (ctx) => {
  const filename = ctx.query.get('filename') || 'template.pptx';
  const buf = await readBody(ctx.req, config().limits.uploadMaxBytes);
  if (!buf.length) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '模板内容为空'));
  const custom = await planner.importCustomTemplate(ctx.params.id, buf, filename);
  sendJson(ctx.res, 200, { ok: true, custom });
});

route('GET', '/projects/:id/style/template', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, custom: await planner.getCustomStyle(ctx.params.id) });
});

route('POST', '/projects/:id/style', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const {meta}=await projects.loadProject(ctx.params.id);
  const auto = meta.template_selection?.mode==='template_fill' ? await ensureActionReady(ctx.params.id, 'outline') : [];
  const sel = await planner.selectStyle(ctx.params.id, { family: body.family, count: body.count, custom: body.custom });
  sendJson(ctx.res, 200, { ok: true, selection: sel, stage:sel.template_selection ? (meta.version?'done':'material') : 'pages', auto_chained: auto });
});

route('POST', '/projects/:id/plan', async (ctx) => {
  const auto = await ensureActionReady(ctx.params.id, 'style'); // 0.3.4.1：WF-03/04 自动补齐，不再拦截
  const plan = await planner.buildPlan(ctx.params.id, {});
  sendJson(ctx.res, 200, { ok: true, plan, pageLayouts: planner.planToPageLayouts(plan), auto_chained: auto });
});

route('POST', '/projects/:id/plan/reroll', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const page = await planner.rerollPage(ctx.params.id, body.n);
  const plan = await planner.getPlan(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true, page, pageLayouts: plan ? planner.planToPageLayouts(plan) : null });
});
route('POST','/projects/:id/layout-preferences',async(ctx)=>{ const body=await readJsonBody(ctx.req); sendJson(ctx.res,200,{ok:true,preferences:await planner.addLayoutPreference(ctx.params.id,body.layout_id,body.n)}); });
route('GET','/projects/:id/layout-preferences',async(ctx)=>{await projects.loadProject(ctx.params.id);sendJson(ctx.res,200,{ok:true,preferences:await readJson(path.join(projects.projectDir(ctx.params.id),'layout-preferences.json'),[])});});

route('GET','/projects/:id/components',async(ctx)=>{
  const {runComponentCommand}=await import('./component-service.js');
  const result=await runComponentCommand(ctx.params.id,{command:'search-visual',scope:'trial_candidates',query:ctx.query.get('query') || ''});
  sendJson(ctx.res,200,{ok:true,components:result.result});
});
for(const command of ['retire','restore','promote'])route('POST','/projects/:id/components/:componentId/'+command,async(ctx)=>{
  const body=await readJsonBody(ctx.req);
  const {runComponentCommand}=await import('./component-service.js');
  const request={command,component_id:ctx.params.componentId,component_version:body.component_version};
  if(command==='retire')request.reason=String(body.reason || '').trim();
  if(command==='promote')Object.assign(request,{confirmed_by:body.confirmed_by,note:body.note,proof:body.proof});
  const result=await runComponentCommand(ctx.params.id,request);
  sendJson(ctx.res,200,{ok:true,component:result.result});
});
route('POST','/projects/:id/samples/confirm',async(ctx)=>sendJson(ctx.res,200,{ok:true,approval:await generate.confirmSamples(ctx.params.id,await readJsonBody(ctx.req))}));

route('GET', '/projects/:id/plan', async (ctx) => {
  const plan = await planner.getPlan(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true, plan, pageLayouts: plan ? planner.planToPageLayouts(plan) : null });
});

/* ── WF-06：生成（构建/渲染/巡检）任务 ────────────────────────── */

route('POST', '/projects/:id/generate', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  if(typeof body.request_id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(body.request_id))throw apiError('REQUIRED_FIELD_MISSING','生成需要稳定request_id');
  const {meta}=await projects.loadProject(ctx.params.id);
  if(body.phase && meta.template_selection?.mode!=='template_fill')throw apiError('INVALID_OPERATION','组件稿不能经旧phase进入原页填充流程');
  if (!body.phase) {
    const {resolveProductionIntent}=await import('./workflow.js');
    const intent=await resolveProductionIntent(ctx.params.id,body.text || '');
    const r=await generate.startComposition(ctx.params.id,{...intent,request_id:body.request_id,text:body.text || ''});
    return sendJson(ctx.res,200,{ok:true,...r});
  }
  const r = await generate.startGenerate(ctx.params.id, { phase: body.phase === 'final' ? 'final' : 'sample' });
  sendJson(ctx.res, 200, { ok: true, ...r });
});
route('POST','/projects/:id/render',async(ctx)=>sendJson(ctx.res,200,{ok:true,...await generate.startRender(ctx.params.id)}));

route('GET', '/jobs/:jobId', async (ctx) => {
  const job = getJobById(ctx.params.jobId);
  if (!job) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '任务不存在：' + ctx.params.jobId));
  sendJson(ctx.res, 200, { ok: true, job: jobViewOf(job) });
});

route('POST', '/jobs/:jobId/retry', async(ctx)=>{
  const job=getJobById(ctx.params.jobId);
  if(!job) throw apiError('SOURCE_NOT_FOUND','任务不存在');
  if(!['failed','interrupted','cancelled'].includes(job.status)) throw apiError('INVALID_OPERATION','仅能重试失败、中断或取消的任务');
  const r=job.type==='render' ? await generate.startRender(job.project_id) : (await ensureActionReady(job.project_id,'plan'),await generate.startGenerate(job.project_id,{phase:job.meta?.phase || 'sample'}));
  sendJson(ctx.res,200,{ok:true,...r,retry_of:job.id});
});

route('POST', '/jobs/:jobId/cancel', async (ctx) => {
  const job = cancelJobById(ctx.params.jobId);
  if (!job) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '任务不存在：' + ctx.params.jobId));
  sendJson(ctx.res, 200, { ok: true, job: jobViewOf(job) });
});

route('GET', '/projects/:id/report', async (ctx) => {
  const { meta } = await projects.loadProject(ctx.params.id);
  if (!meta.latest_report) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '尚无生成报告'));
  sendJson(ctx.res, 200, { ok: true, report: await readJson(path.join(projects.projectDir(ctx.params.id), meta.latest_report), null) });
});

/* ── WF-07：双通道修订（对话指令 / 画布操作队列） ─────────────── */

route('POST', '/projects/:id/revise', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const instruction = String(body.instruction || body.text || '').trim();
  if (!instruction) return sendJson(ctx.res, 400, apiError('INVALID_OPERATION', '修订指令不能为空'));
  const r = await dialogue.handleProductionMessage(ctx.params.id, instruction, {message_id:body.request_id,model_id:body.model_id || null});
  sendJson(ctx.res, 200, { ok: true, ...r });
});

route('GET', '/projects/:id/shapes', async (ctx) => {
  const page = ctx.query.get('page') || '1';
  sendJson(ctx.res, 200, { ok: true, ...(await revise.pageShapes(ctx.params.id, page)) });
});

route('POST', '/projects/:id/rollback', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const res = await revise.rollbackVersion(ctx.params.id, String(body.label || ''), {version:body.version,expected_sha256:body.expected_sha256});
  sendJson(ctx.res, 200, { ok: true, ...res });
});

route('POST', '/projects/:id/patch', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  if (!body.expected_sha256 || !body.version) throw apiError('REQUIRED_FIELD_MISSING','编辑需要基准版本和 SHA，请重新加载画布');
  const {meta}=await projects.loadProject(ctx.params.id);
  if(meta.component_state_path && (!Number.isInteger(body.expected_revision)||typeof body.request_id!=='string'||!body.request_id))throw apiError('INVALID_OPERATION','组件编辑需要当前组件修订号与稳定请求ID');
  if(typeof body.request_id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(body.request_id)) throw apiError('REQUIRED_FIELD_MISSING','画布编辑需要稳定request_id');
  const r = await revise.startPatchJob(ctx.params.id, body.operations || [], { source: body.source || 'canvas', note: body.note || '',expected_sha256:body.expected_sha256,version:body.version,expected_revision:body.expected_revision,request_id:body.request_id });
  sendJson(ctx.res, 200, { ok: true, ...r });
});

/* ── WF-08：导出 / 下载 / 归档语义 ────────────────────────────── */

route('POST', '/projects/:id/export', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const r = await exporter.exportProject(ctx.params.id, { note: String(body.note || '') });
  if(!r.deduplicated)await dialogue.persist(ctx.params.id,[{role:'ai',kind:'archived',payload:{real:true,export_id:r.id,version:r.version,sha256:r.sha256,
    download_name:r.download_name,document_state:r.document_state,archived:!!r.archived}}]);
  sendJson(ctx.res, 200, { ok: true, ...r });
});

route('GET', '/projects/:id/exports', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, exports: await exporter.exportsRegistry(ctx.params.id) });
});
route('GET','/exports/orphans',async(ctx)=>sendJson(ctx.res,200,{ok:true,exports:await exporter.orphanExports()}));
route('DELETE','/exports/orphans/:id',async(ctx)=>sendJson(ctx.res,200,{ok:true,...await exporter.deleteOrphanExport(ctx.params.id)}));
route('GET','/projects/:id/annotations',async(ctx)=>sendJson(ctx.res,200,{ok:true,annotations:await editor.annotations(ctx.params.id,ctx.query.get('version'))}));
route('POST','/projects/:id/annotations',async(ctx)=>sendJson(ctx.res,200,{ok:true,annotation:await editor.addAnnotation(ctx.params.id,await readJsonBody(ctx.req))}));
route('DELETE','/projects/:id/annotations/:aid',async(ctx)=>sendJson(ctx.res,200,{ok:true,...await editor.deleteAnnotation(ctx.params.id,ctx.params.aid)}));
route('POST','/projects/:id/annotations/submit',async(ctx)=>sendJson(ctx.res,200,{ok:true,...await editor.submitAnnotations(ctx.params.id,await readJsonBody(ctx.req))}));
route('POST','/projects/:id/compare',async(ctx)=>{const body=await readJsonBody(ctx.req);sendJson(ctx.res,200,{ok:true,...await editor.compareVersions(ctx.params.id,body.left,body.right)});});

route('GET', '/projects/:id/download', async (ctx) => {
  const dl = await exporter.downloadVersion(ctx.params.id,{version:ctx.query.get('version'),export_id:ctx.query.get('export_id')});
  const stat = await fsp.stat(dl.path);
  ctx.res.writeHead(200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'content-length': stat.size,
    'content-disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(dl.name),
    'cache-control': 'no-store',
  });
  fs.createReadStream(dl.path).pipe(ctx.res);
  return true;
});

/* ── WF-10：模板学习 / 审批 / 知识治理 ───────────────────────── */

route('GET', '/template-folders', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, templates: await knowledge.listTemplateFolders() });
});

route('POST', '/template-folders/learn', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  if (!body.project_id) return sendJson(ctx.res, 400, apiError('REQUIRED_FIELD_MISSING', '缺少 project_id'));
  const r = await knowledge.learnFromProject(body.project_id);
  sendJson(ctx.res, 200, { ok: true, ...r });
});

route('POST', '/template-folders/:id/approve', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const r = await knowledge.approveTemplateFolder(ctx.params.id, body.confirmed_by, body.note);
  sendJson(ctx.res, 200, { ok: true, template: r });
});

route('GET', '/template-folders/:id/knowledge-candidates', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, candidates: await knowledge.knowledgeCandidates(ctx.params.id) });
});

route('POST', '/template-folders/:id/knowledge/confirm', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  if (!body.candidate_id) return sendJson(ctx.res, 400, apiError('REQUIRED_FIELD_MISSING', '缺少 candidate_id'));
  const r = await knowledge.confirmTemplateKnowledge(ctx.params.id, body.candidate_id, body.confirmed_by);
  sendJson(ctx.res, 200, { ok: true, ...r });
});

route('GET', '/knowledge', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, knowledge: await knowledge.listKnowledge() });
});

route('POST', '/projects/:id/knowledge/facts', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const r = await knowledge.addMaterialFact(ctx.params.id, body);
  sendJson(ctx.res, 200, { ok: true, fact: r });
});

route('GET', '/projects/:id/knowledge/facts', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true, facts: await knowledge.listMaterialFacts(ctx.params.id) });
});
route('POST','/projects/:id/knowledge/facts/analyze',async(ctx)=>{const body=await readJsonBody(ctx.req);sendJson(ctx.res,200,{ok:true,facts:await knowledge.analyzeMaterialFacts(ctx.params.id,body.model_id)});});

route('POST', '/projects/:id/knowledge/facts/:factId/confirm', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const r = await knowledge.confirmMaterialFact(ctx.params.id, ctx.params.factId, body.confirmed_by);
  sendJson(ctx.res, 200, { ok: true, fact: r });
});

/* ── 数据文件（项目预览 PNG / 自定义素材，只读）：/data-file/<任意深度路径> ── */

async function handleDataFile(ctx) {
  const rel = ctx.pathname.replace(/^\/data-file\//, '');
  const root = config().dataDir;
  const abs = safeJoin(root, rel);
  const ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) return sendJson(ctx.res, 403, apiError('FORBIDDEN', '不允许的资源类型'));
  if (ext === '.pptx' && !/^projects\/[^/]+\/(?:reference|custom-template)\.pptx$/.test(rel) &&
      !/^projects\/[^/]+\/sources\/mat-[a-f0-9-]{36}\.pptx$/.test(rel)) {
    return sendJson(ctx.res, 403, apiError('FORBIDDEN', '生成稿仅可通过已验证版本的下载接口获取'));
  }
  let st;
  try { st = await fsp.stat(abs); } catch {
    return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '资源不存在'));
  }
  if (!st.isFile()) return sendJson(ctx.res, 404, apiError('SOURCE_NOT_FOUND', '资源不存在'));
  ctx.res.writeHead(200, { 'content-type': MIME[ext], 'content-length': st.size, 'cache-control': 'private, max-age=60' });
  fs.createReadStream(abs).pipe(ctx.res);
}

/* ── 分发 ────────────────────────────────────────────────────── */

export async function handleApi(req, res, url, routePathArg) {
  // routePathArg：index.js 已剥去 /api/huiwen-ppt 前缀的路径（如 /api/data、/projects/x/state）
  let pathname = String(routePathArg || url.pathname).replace(/\/{2,}/g, '/');
  // 方案 §9.2 路由形如 /api/styles：包前缀与 /api 段都已剥去后再匹配路由表
  if (pathname === '/api') pathname = '/';
  else if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
  if (pathname.startsWith('/data-file/') && (req.method || 'GET').toUpperCase() === 'GET') {
    try {
      await handleDataFile({ req, res, pathname });
    } catch (e) { fail(res, e); }
    return true;
  }
  for (const r of routes) {
    if (r.method !== (req.method || 'GET').toUpperCase()) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const context={ req, res, url, params, query: url.searchParams };
      const mutatesProject=params.id && pathname.startsWith('/projects/') && ['POST','DELETE'].includes(r.method);
      const queuesInput=/\/conversation\/message$/.test(pathname);
      if(mutatesProject && !queuesInput && /\/(brief|outline|style|materials|layout-preferences|conversation)(\/|$)/.test(pathname)) await cancelProjectJobs(params.id);
      if(mutatesProject && !queuesInput && !/\/(reset|generate|render)$/.test(pathname) && !(r.method==='DELETE' && /^\/projects\/[^/]+$/.test(pathname))) await withProjectLock(params.id,()=>r.handler(context));
      else await r.handler(context);
    } catch (e) {
      fail(res, e);
    }
    return true;
  }
  sendJson(res, 404, apiError('NOT_FOUND', 'API 路由不存在：' + pathname, null, false));
  return true;
}

/** 供 index.js 判断是否属于 API 区（含未匹配时也接管，返回 404 JSON 而非穿透） */
export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}
