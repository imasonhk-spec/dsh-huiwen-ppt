import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loadProject, projectDir } from './projects.js';
import { readJson, runCmd, safeJoin, sha256File } from './util.js';

const resource = fileURLToPath(new URL('../resources/huiwen-ppt/', import.meta.url));
const builtins = {
  'green-clean-business': 'clean-business',
  'green-office-illustrated': 'style-library',
};
const commands = new Set(['capabilities', 'index', 'search', 'search-visual', 'composition-ledger', 'audit-visual', 'get', 'style', 'compile', 'build', 'apply-revision', 'validate', 'record-use', 'promote', 'retire', 'restore', 'thumbnails']);
const forbidden = new Set(['library', 'source', 'output', 'state', 'render_dir', 'style_source', 'component_library', 'result_file']);

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function resolveTemplateSelection(selection, accountContext = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw error('INVALID_SELECTION', '模板选择必须为对象');
  for (const key of Object.keys(selection)) {
    if (key !== 'style_source' && (forbidden.has(key) || !['family', 'template_id', 'component_template_id', 'template_version', 'source_sha256', 'preferred_layout_ids', 'mode', 'decision_source'].includes(key))) throw error('FORBIDDEN', `不允许客户端指定 ${key}`);
  }
  const dirName = builtins[selection.family];
  if (!dirName && !/^[A-Za-z0-9_-]{1,100}$/.test(selection.family || '')) throw error('INVALID_SELECTION', '未知模板风格');
  const accountRoot = path.join(config().dataDir, 'library', 'templates');
  const folder = dirName ? path.join(resource, 'assets', dirName) : path.join(accountRoot, selection.family);
  if (!dirName && await fsp.realpath(folder).then((actual) => !actual.startsWith(path.resolve(accountRoot) + path.sep)).catch(() => false)) throw error('FORBIDDEN', '模板不属于当前账号');
  const manifest = await readJson(path.join(folder, 'manifest.json'), null);
  const layoutIndex = dirName ? await readJson(path.join(folder, 'layout-index.json'), null) : null;
  if (!manifest || dirName && !layoutIndex) throw error('SOURCE_NOT_FOUND', '模板资源缺失');
  if (!dirName && manifest.id !== selection.family) throw error('SOURCE_CHANGED', '模板身份不匹配');
  if (!dirName && manifest.status !== 'approved') {
    const origin = accountContext.allowDraftForProject && path.join(config().dataDir, 'projects', accountContext.allowDraftForProject, 'custom-template.pptx');
    if (!origin || manifest.source_path !== origin || await sha256File(origin).catch(() => null) !== manifest.source_sha256) throw error(accountContext.allowDraftForProject ? 'FORBIDDEN' : 'TEMPLATE_NOT_APPROVED', '上传模板尚未批准或不属于原项目');
  }
  const source = path.join(folder, 'reference.pptx');
  if (!dirName && await fsp.realpath(source).then((actual) => !actual.startsWith(path.resolve(folder) + path.sep)).catch(() => true)) throw error('FORBIDDEN', '模板源文件越出当前账号目录');
  if (selection.style_source && selection.style_source !== source) throw error('FORBIDDEN', '模板路径不匹配固定资源');
  const sha = await sha256File(source);
  if (sha !== (dirName ? manifest.reference_sha256 : manifest.source_sha256) || dirName && sha !== layoutIndex.sha256) throw error('SOURCE_CHANGED', '模板来源校验失败');
  const componentTemplateId = dirName ? (dirName === 'clean-business' ? 'clean' : 'illustrated') : manifest.id;
  const version = dirName ? layoutIndex.version : manifest.version;
  if (selection.source_sha256 && selection.source_sha256 !== sha || selection.template_version && selection.template_version !== version || selection.template_id && selection.template_id !== manifest.id || selection.component_template_id && selection.component_template_id !== componentTemplateId) throw error('SOURCE_CHANGED', '模板版本已变化');
  const preferred = selection.preferred_layout_ids || [];
  if (!Array.isArray(preferred) || preferred.some((id) => dirName ? !layoutIndex.layouts.some((layout) => layout.id === id) : !Array.from({ length: manifest.slide_count }, (_, n) => `${manifest.id}-slide-${n + 1}`).includes(id))) throw error('INVALID_SELECTION', '指定版式不在所选模板内');
  if (selection.mode && !['compose', 'template_fill'].includes(selection.mode)) throw error('INVALID_SELECTION', '未知制作模式');
  if (selection.decision_source && !['user', 'policy'].includes(selection.decision_source)) throw error('INVALID_SELECTION', '未知选择来源');
  return { family: selection.family, template_id: manifest.id, component_template_id: componentTemplateId, template_version: version, source_sha256: sha,
    style_source: source, preferred_layout_ids: preferred, mode: selection.mode || 'compose', decision_source: selection.decision_source || 'user' };
}

async function componentLibrary() {
  const root = path.join(config().dataDir, 'library', 'components');
  const source = path.join(resource, 'assets', 'components');
  if (fs.existsSync(path.join(root, 'index.json'))) return root;
  await fsp.mkdir(path.dirname(root), { recursive: true });
  // A completed copy is published atomically; another concurrent request can use it.
  const tmp = root + '.seed-' + process.pid + '-' + Math.random().toString(36).slice(2);
  try {
    await fsp.cp(source, tmp, { recursive: true });
    try { await fsp.rename(tmp, root); }
    catch (e) { if (e.code !== 'EEXIST' && e.code !== 'ENOTEMPTY') throw e; }
  } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  return root;
}

async function projectFile(dir, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw error('FORBIDDEN', '仅允许项目内的相对文件路径');
  const target = safeJoin(dir, value);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualRoot = await fsp.realpath(dir);
  const actualAncestor = await fsp.realpath(ancestor);
  if (actualAncestor !== actualRoot && !actualAncestor.startsWith(actualRoot + path.sep)) throw error('FORBIDDEN', '项目路径不可穿过外部符号链接');
  return target;
}

export async function resolveComponentImageAsset(projectId, assetId) {
  const { buildIndex } = await import('./index-builder.js');
  const asset=(await buildIndex()).assets.find(item=>item.id===assetId);
  if(asset) {
    const fixed=path.join(fileURLToPath(new URL('../assets/previews/', import.meta.url)),asset.file);
    if(!fs.existsSync(fixed)) throw error('SOURCE_NOT_FOUND','内置图片素材缺失');
    return fixed;
  }
  const { listMaterials } = await import('./materials.js');
  const material=(await listMaterials(projectId)).find(item=>item.id===assetId);
  if(!material||material.role!=='visual-reference') throw error('SOURCE_NOT_FOUND','项目图片材料不存在');
  if(!['png','jpg','jpeg','svg'].includes(material.type)) throw error('UNSUPPORTED_OBJECT','原生插图仅支持PNG、JPEG或SVG图片');
  const source=await projectFile(projectDir(projectId),material.file);
  if(await sha256File(source).catch(()=>null)!==material.sha256) throw error('SOURCE_CHANGED','项目图片材料已变化');
  return source;
}

async function persistedProof(projectId, meta, command, request, signal) {
  const dir = projectDir(projectId);
  const fail = () => { throw error('INVALID_EVIDENCE', '当前版本缺少真实完整视觉、渲染与可编辑性 QA 证明'); };
  if (!/^v\d{4,}$/.test(meta.version || '') || !meta.source_name || !meta.component_state_path || !/^[a-f0-9]{64}$/.test(meta.source_sha256 || '')) fail();
  if (command === 'record-use' && request.task_id !== projectId) fail();
  const sourceRel = 'versions/' + meta.source_name;
  let source, state, qa, review, render, editability;
  try {
    source = await projectFile(dir, sourceRel);
    state = await projectFile(dir, meta.component_state_path);
    qa = await readJson(path.join(dir, 'qa-report-' + meta.version + '.json'), null);
    review = await readJson(path.join(dir, 'qa-review-' + meta.version + '.json'), null);
    if (!qa || !review || await sha256File(source) !== meta.source_sha256) fail();
    const savedState = await readJson(state, null);
    if (savedState?.project_id !== projectId || savedState.sha256 !== meta.source_sha256) fail();
    if (typeof review.render_report !== 'string' || typeof review.editability_report !== 'string') fail();
    const renderFile = await projectFile(dir, review.render_report);
    const editabilityFile = await projectFile(dir, review.editability_report);
    render = await readJson(renderFile, null);
    editability = await readJson(editabilityFile, null);
    const pages = Array.from({ length: render?.slide_count || 0 }, (_, i) => i + 1);
    if (!pages.length || !render.engine || render.source_sha256 !== meta.source_sha256 ||
        !Array.isArray(render.files) || render.files.length !== pages.length ||
        !pages.every((n) => render.files.some((f) => f.slide === n)) ||
        !Array.isArray(review.reviewed_pages) || stableHash([...review.reviewed_pages].sort((a, b) => a - b)) !== stableHash(pages) ||
        typeof review.reviewer !== 'string' || !review.reviewer.trim() ||
        review.source_sha256 !== meta.source_sha256 || review.visual !== 'passed' || review.editability !== 'passed' ||
        !Array.isArray(review.unresolved) || review.unresolved.length ||
        editability?.source_sha256 !== meta.source_sha256 || editability.status !== 'passed' ||
        !editability.engine || !editability.mode || !editability.samples || !Object.keys(editability.samples).length || Object.values(editability.samples).some((value) => value !== 'passed')) fail();
    for (const f of render.files) {
      if (typeof f.file !== 'string' || path.isAbsolute(f.file) || !f.file.endsWith('.png')) fail();
      const image = await projectFile(dir, path.join(path.relative(dir, path.dirname(renderFile)), f.file));
      const handle = await fsp.open(image, 'r');
      try {
        const signature = Buffer.alloc(8);
        const { bytesRead } = await handle.read(signature, 0, 8, 0);
        if (bytesRead !== 8 || !signature.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail();
      } finally { await handle.close(); }
    }
    if (qa.source_sha256 !== meta.source_sha256 || qa.output_sha256 !== meta.source_sha256 ||
        qa.status !== 'passed' || qa.structure !== 'passed' || qa.visual !== 'passed' || qa.editability !== 'passed' ||
        !Array.isArray(qa.unresolved) || qa.unresolved.length ||
        stableHash(qa.render) !== stableHash(render) || stableHash(qa.editability_evidence) !== stableHash(editability)) fail();
    const verified = (await runComponentCommand(projectId, { command: 'validate', source: sourceRel,
      state: meta.component_state_path, review: { ...review, render_report: render, editability_report: editabilityFile } }, { signal })).result;
    if (verified.status !== 'passed' || verified.output_sha256 !== meta.source_sha256 ||
        verified.structure !== qa.structure || verified.visual !== qa.visual || verified.editability !== qa.editability ||
        stableHash(verified.render) !== stableHash(render) || stableHash(verified.editability_evidence) !== stableHash(editability)) fail();
    const current=(await loadProject(projectId)).meta;
    if (current.version !== meta.version || current.source_sha256 !== meta.source_sha256 || await sha256File(source) !== meta.source_sha256) fail();
  } catch (e) { if (e.code === 'ABORT_ERR') throw e; fail(); }
  return { ...qa, output_file: source, state_file: state, output_sha256: meta.source_sha256 };
}

export async function runComponentCommand(projectId, request, { signal } = {}) {
  if (!request || typeof request !== 'object' || !commands.has(request.command)) throw error('INVALID_COMMAND', '不支持的组件命令');
  if (signal?.aborted) throw error('ABORT_ERR', '操作已取消');
  if (Object.keys(request).some((key) => ['library', 'result_file', 'component_library'].includes(key))) throw error('FORBIDDEN', '组件库路径由当前账号解析');
  const { meta } = await loadProject(projectId);
  const dir = projectDir(projectId);
  const library = await componentLibrary();
  const payload = { ...request, library };
  payload.project_id = projectId;
  if (request.command === 'index' || request.command === 'style') {
    if (request.uploaded_template_id && request.command !== 'index') throw error('FORBIDDEN', '仅项目结构提取可使用上传模板标识');
    if (request.uploaded_template_id) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.uploaded_template_id)) throw error('FORBIDDEN', '非法模板标识');
      const manifest = await readJson(path.join(config().dataDir, 'library', 'templates', request.uploaded_template_id, 'manifest.json'), null);
      if (!manifest || manifest.source_path !== path.join(dir, 'custom-template.pptx') || await sha256File(manifest.source_path).catch(() => null) !== manifest.source_sha256) throw error('FORBIDDEN', '模板原件不属于当前项目或已变化');
    }
    const selected = await resolveTemplateSelection(request.uploaded_template_id ? { family: request.uploaded_template_id } : request.selection || meta.template_selection,
      request.uploaded_template_id ? { allowDraftForProject: projectId } : {});
    payload.source = selected.style_source;
    payload.template_id = request.command === 'index' ? selected.component_template_id : selected.template_id;
    if (request.command === 'index' && builtins[selected.family]) payload.annotations = path.join(resource, 'assets', 'components', `annotations-${payload.template_id}.json`);
  } else {
    for (const key of ['source', 'output', 'state', 'render_dir']) if (key in payload) payload[key] = await projectFile(dir, payload[key]);
  }
  if (payload.plan) {
    if (typeof payload.plan !== 'object' || Array.isArray(payload.plan)) throw error('INVALID_PLAN', '组件计划必须为对象');
    const selected = await resolveTemplateSelection(request.selection || meta.template_selection);
    if (payload.plan.component_library && payload.plan.component_library !== library || payload.plan.style_source && payload.plan.style_source !== selected.style_source || payload.plan.style_sha256 && payload.plan.style_sha256 !== selected.source_sha256) throw error('FORBIDDEN', '计划中的来源必须匹配Host固定模板');
    payload.plan = { ...payload.plan, project_id: projectId, style_source: selected.style_source, style_sha256: selected.source_sha256, component_library: library };
    if (request.command === 'build' || request.command === 'compile') {
      const old=request.source&&meta.component_state_path?await readJson(await projectFile(dir,meta.component_state_path),null):null;
      const originals=payload.plan.slides?.slice(old?.slides?.length||0).flatMap(slide=>slide.originals||[])||[];
      if (originals.some(original=>original.kind==='image')) {
        for (const original of originals) {
          if (original.kind!=='image') continue;
          const fixed=await resolveComponentImageAsset(projectId,original.asset_id);
          if (original.asset_path && original.asset_path!==fixed) throw error('FORBIDDEN', '原生图片只能引用当前项目材料或固定素材');
          original.asset_path=fixed;
        }
      }
    }
  }
  if (['build','compile'].includes(request.command) && ['source','state','expected_sha256'].some(key=>key in request)) {
    if (!['source','state','expected_sha256'].every(key=>key in request) || !meta.source_name || !meta.component_state_path ||
        payload.source!==path.join(dir,'versions',meta.source_name) || payload.state!==await projectFile(dir,meta.component_state_path) ||
        request.expected_sha256!==meta.source_sha256 || await sha256File(payload.source)!==request.expected_sha256)
      throw error('VERSION_CONFLICT', '续稿基准不是当前已提交的样张');
    const old=await readJson(payload.state,null);
    if (!old || old.project_id!==projectId || old.sha256!==request.expected_sha256 ||
        old.plan?.style_sha256 !== (await resolveTemplateSelection(meta.template_selection)).source_sha256)
      throw error('VERSION_CONFLICT', '样张状态与固定来源不一致');
    if (old.plan.style_sha256!==payload.plan?.style_sha256) throw error('SOURCE_CHANGED', '跨风格续稿须重新构建，不得复用旧样张母版');
  } else if (request.command === 'build' && meta.component_state_path && meta.source_name) {
    const source=path.join(dir,'versions',meta.source_name);
    const old=await readJson(await projectFile(dir,meta.component_state_path),null);
    if (!old || old.sha256!==meta.source_sha256 || await sha256File(source).catch(()=>null)!==meta.source_sha256)
      throw error('VERSION_CONFLICT', '当前组件版本缺失或发生变化');
    if (old.plan?.slides?.some(slide=>slide.locks?.length))
      throw error('LOCK_CONFLICT', '当前样张含锁定对象或区域，请先解锁再重新构建全稿');
  }
  if (payload.proof) {
    if (typeof payload.proof !== 'object' || Array.isArray(payload.proof)) throw error('INVALID_EVIDENCE', '证明必须为对象');
    payload.proof = { ...payload.proof };
    for (const key of ['output_file', 'state_file']) if (key in payload.proof) payload.proof[key] = await projectFile(dir, payload.proof[key]);
  }
  if (request.command === 'promote' || request.command === 'record-use') payload.proof = await persistedProof(projectId, meta, request.command, request, signal);
  delete payload.selection;
  delete payload.uploaded_template_id;
  const reqDir = path.join(config().dataDir, 'cache');
  await fsp.mkdir(reqDir, { recursive: true });
  const file = path.join(reqDir, `component-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    await fsp.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    const result = await runCmd(config().python, [path.join(resource, 'scripts', 'components.py'), '--request', file], { timeoutMs: 300000, signal });
    if (signal?.aborted || result.err?.name === 'AbortError') throw error('ABORT_ERR', '操作已取消');
    let response;
    try { response = JSON.parse(result.code === 0 ? result.stdout : result.stderr); }
    catch { throw error(result.killed ? 'TIMEOUT' : 'COMPONENT_COMMAND_FAILED', result.stderr || String(result.err || '组件命令失败')); }
    if (!response.ok) throw error(response.error?.code || 'COMPONENT_COMMAND_FAILED', response.error?.message || '组件命令失败');
    return response;
  } finally { await fsp.rm(file, { force: true }); }
}
