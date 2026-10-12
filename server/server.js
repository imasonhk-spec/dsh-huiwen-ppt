/**
 * 汇文 PPT 后端 · 组合根（server/server.js）
 * index.js 在 apply() 时调用 initCore()（异步，不阻塞插件加载），
 * HTTP 请求经认证门禁后交给 handlePackRequest 分发。
 */

import { initConfig, config } from './config.js';
import { markInterruptedOnBoot } from './jobs.js';
import { ensureBuiltins, buildIndex } from './index-builder.js';
import { engineMatrix } from './engines.js';
import { handleApi, isApiPath } from './router.js';

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const boot = { state: 'idle', error: null, started_at: null, ready_at: null };

export async function initCore() {
  boot.state = 'booting';
  boot.started_at = new Date().toISOString();
  try {
    await initConfig();
    markInterruptedOnBoot();
    boot.state = 'indexing';
    await ensureBuiltins();
    await buildIndex(true);
    await engineMatrix(true);
    boot.state = 'ready';
    boot.ready_at = new Date().toISOString();
    console.log('[huiwen-ppt] 后端就绪：dataDir=' + config().dataDir);
  } catch (e) {
    boot.state = 'degraded';
    boot.error = e.message;
    console.error('[huiwen-ppt] 后端降级：', e.message);
  }
}

export function bootState() {
  return { ...boot };
}

/** 分发（已过认证门禁）：API 区接管所有 /api/* 与 /data-file/* */
export async function handlePackRequest(req, res, url, routePath) {
  if (isApiPath(routePath) || routePath.startsWith('/data-file/')) {
    if (boot.state === 'booting' || boot.state === 'indexing') {
      sendJson(res, 503, {
        ok: false, code: 'BOOTING', message: '插件后端正在初始化（' + boot.state + '），稍后重试',
        recoverable: true, next_actions: ['retry'],
      });
      return true;
    }
    await handleApi(req, res, url, routePath);
    return true;
  }
  return false;
}
