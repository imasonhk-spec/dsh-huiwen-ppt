/**
 * 汇文 PPT（@local/huiwen-ppt）—— Host 半
 *
 * 职责（真实后端阶段）：
 *   1. 导出能力包清单 MANIFEST 并向工作台注册（workbenchCapabilities，含延迟重试）；
 *   2. /api/huiwen-ppt/api/*  真实后端 API（server/ 模块：资源索引、项目、引擎、模型…）；
 *   3. /api/huiwen-ppt/assets/...  内置模板预览静态路由（只读）；
 *   4. /api/huiwen-ppt/data-file/...  数据目录文件（项目预览/自定义素材，只读）；
 *   5. 认证门禁：所有请求先过 connection.requestRejection（与政策解读一致）。
 *
 * 硬性约束（与政策解读插件同一契约）：
 *   - ESM；禁止任何 npm 依赖导入；仅使用 node: 内置模块；
 *   - 运行数据写入 dataDir（默认工作区 huiwen-data/），包目录保持只读。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCore, handlePackRequest, bootState } from './server/server.js';
import { VERSION } from './server/meta.js';
import { installLicense } from './license-http.mjs'; /* PATCH:WB-LIC-IMPORT */

export { VERSION };

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = path.join(PKG_ROOT, 'assets');

/** 宿主上下文（认证门禁用；卸载时清除） */
let PACK_CONTEXT = null;

/** 能力包清单（CAPABILITY-PACK-API v1.0） */
export const MANIFEST = {
  id: 'huiwen-ppt',
  title: '汇文 PPT',
  description: '模板驱动的 PPT 快速生产：模板库、对话制作、画布审阅与版本导出（真实后端）',
  entryKey: 'cap:huiwen-ppt',
  order: 20,
  icon: '🎬',
  category: '协作效率',
  version: 'v'+VERSION,
  tags: ['模板库', '对话制作', '画布审阅'],
  subs: ['模板库', '对话制作', '画布'],
  openEvent: 'cappacks:open-huiwen-ppt',
  openEventAliases: ['cappacks:open-huiwen-ppt'],
};

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * 静态资源路由：GET /api/huiwen-ppt/assets/<相对路径>
 * 白名单：仅 assets/ 目录内、仅已知图片/数据扩展名；路径穿越一律 403。
 */
export async function handlePackHttpRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '非法请求 URL' });
    return;
  }
  if (url.pathname !== '/api/huiwen-ppt' && !url.pathname.startsWith('/api/huiwen-ppt/')) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '路由不存在' });
    return;
  }
  let connection;
  try { connection = PACK_CONTEXT && PACK_CONTEXT.get && PACK_CONTEXT.get('connection'); } catch {}
  if (!connection || typeof connection.requestRejection !== 'function') {
    sendJson(res, 503, { ok: false, code: 'AUTH_UNAVAILABLE', message: '认证门禁不可用，HTTP路由未开放' });
    return;
  }
  let rejection;
  try { rejection = connection.requestRejection({ headers: req.headers || {} }); } catch {
    sendJson(res, 503, { ok: false, code: 'AUTH_UNAVAILABLE', message: '认证门禁校验失败' });
    return;
  }
  if (rejection !== undefined) {
    const status = rejection === 401 ? 401 : rejection === 403 ? 403 : 503;
    sendJson(res, status, {
      ok: false,
      code: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'AUTH_UNAVAILABLE',
      message: '请求未通过同一认证门禁',
    });
    return;
  }

  const route = url.pathname.replace(/^\/api\/huiwen-ppt/, '') || '/';

  // 包身份探测
  if (route === '/' || route === '') {
    sendJson(res, 200, {
      ok: true, id: 'huiwen-ppt', version: VERSION,
      prototype: false, backend: bootState().state,
      routes: ['/api/*', '/assets/<file>', '/data-file/<file>', '/download'],
    });
    return;
  }

  // 真实后端 API（认证门禁已在上方完成；内部再按 boot 状态把关）
  try {
    const handled = await handlePackRequest(req, res, url, route);
    if (handled) return;
  } catch (e) {
    sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '后端处理失败：' + (e && e.message ? e.message : String(e)) });
    return;
  }

  // 静态预览资源（只读）
  if (route.startsWith('/assets/')) {
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '静态资源仅支持 GET' });
      return;
    }
    const rel = decodeURIComponent(route.slice('/assets/'.length));
    const resolved = path.resolve(ASSETS_ROOT, rel);
    if (!resolved.startsWith(ASSETS_ROOT + path.sep)) {
      sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '路径越界' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!MIME[ext]) {
      sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '不允许的资源类型' });
      return;
    }
    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '资源不存在' });
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[ext],
        'content-length': st.size,
        'cache-control': 'private, max-age=300',
      });
      fs.createReadStream(resolved).pipe(res);
    });
    return;
  }

  sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '路由不存在' });
}

export const inject = ['webServer'];

export function apply(ctx, _config) {
  const disposers = [];
  /* PATCH:WB-LIC-APPLY — 授权收口：本插件自带授权运行时，不依赖工作台；apply 阶段绝不 throw */
  const __lic = installLicense(ctx, { pluginId: 'huiwen-ppt', prefix: '/api/huiwen-ppt' });
  try { disposers.push(() => { try { __lic.gate.flush(); } catch {} }); } catch {}

  PACK_CONTEXT = ctx;
  disposers.push(() => { PACK_CONTEXT = null; });

  // 0. 真实后端初始化（异步：配置/目录/内置分支播种/资源索引/引擎探测）
  initCore().catch((e) => console.error('[huiwen-ppt] initCore 异常：', e && e.message ? e.message : e));

  // 1. HTTP 子前缀路由（CAPABILITY-PACK-API §8：勿用 /api，工作台已占用 /api/workbench）
  try {
    const ws = ctx.webServer || (ctx.get && ctx.get('webServer'));
    if (ws && typeof ws.register === 'function') {
      disposers.push(
        ws.register({
          kind: 'prefix',
          path: '/api/huiwen-ppt',
          handler(req, res) {
            if (__lic.guard(req, res)) return; /* PATCH:WB-LIC-GUARD */
            handlePackHttpRequest(req, res).catch((e) => {
              sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '处理失败：' + (e && e.message ? e.message : String(e)) });
            });
          },
        }),
      );
    }
  } catch { /* webServer 不可用时仅保留 UI */ }

  // 2. 向工作台注册能力清单（与政策解读/会议助手同款延迟重试，保证冷启动卡片必现）
  try {
    let wc = null;
    const attempt = () => {
      try { wc = ctx.get && ctx.get('workbenchCapabilities'); } catch { wc = null; }
      if (wc && typeof wc.register === 'function') {
        try { wc.register(MANIFEST); } catch { return false; }
        disposers.push(() => { try { if (typeof wc.unregister === 'function') wc.unregister(MANIFEST.id); } catch {} });
        return true;
      }
      return false;
    };
    if (!attempt()) {
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (attempt() || tries >= 20) clearInterval(timer);
      }, 150);
      disposers.push(() => clearInterval(timer));
    }
  } catch { /* 工作台框架未启用时跳过注册 */ }

  return () => {
    for (const dispose of disposers.reverse()) { try { if (typeof dispose === 'function') dispose(); } catch {} }
  };
}
