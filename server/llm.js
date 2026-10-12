/**
 * 汇文 PPT 后端 · 真模型客户端（server/llm.js）
 * 对话智能来源：
 *   1. 本机 Ollama（127.0.0.1:11434，原生协议）—— huiwen 专用模型；
 *   2. DSH 同步模型（server/dsh-models.js，OpenAI-compatible /v1）—— 与 DSH 模型列表保持一致。
 * huiwen 专用模型数据源来自 config.ollama.models；DSH 模型数据源来自 cordis.patch.yml（自动跟随）。
 * 模型不可用时由 dialogue 层降级到剧本规则引擎（方案 §5.3：剧本作为兜底与测试夹具）。
 */

import { config } from './config.js';
import { runCmd } from './util.js';
import { findDshModel, probeProvider } from './dsh-models.js';

const TAGS_TTL = 15000;
let tagsCache = null;
let tagsAt = 0;

async function ollamaCurl(method, apiPath, body, timeoutMs) {
  const cfg = config().ollama;
  // node18+ 自带全局 fetch；宿主为现代 Node，直接使用
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || cfg.chatTimeoutMs);
  try {
    const res = await fetch(cfg.base.replace(/\/$/, '') + apiPath, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error('Ollama HTTP ' + res.status + '：' + text.slice(0, 300));
      e.code = 'LLM_UNAVAILABLE';
      throw e;
    }
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') {
      const t = new Error('Ollama 请求超时');
      t.code = 'LLM_TIMEOUT';
      throw t;
    }
    if (!e.code) e.code = 'LLM_UNAVAILABLE';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 模型 tag 列表（带缓存；不可达返回 null） */
export async function listOllamaModels() {
  if (tagsCache && Date.now() - tagsAt < TAGS_TTL) return tagsCache;
  const data = await ollamaCurl('GET', '/api/tags', null, 8000);
  tagsCache = data;
  tagsAt = Date.now();
  return data;
}

/** 校验 modelId → 可用模型；非法/离线时回退默认模型。
 *  ID 优先级：huiwen 专用（config.ollama.models 的 id/tag）→ DSH 命名空间（provider:rawId）→ 默认模型。 */
export async function resolveModel(modelId) {
  const cfg = config().ollama;
  const list = cfg.models || [];
  let m = list.find((x) => x.id === modelId || x.tag === modelId);
  if (m) {
    let online = true;
    let reason = null;
    try {
      const tags = await listOllamaModels();
      const names = (tags.models || []).map((t) => t.name);
      if (!names.includes(m.tag)) { online = false; reason = '模型 ' + m.tag + ' 未在 Ollama 中加载'; }
    } catch (e) {
      online = false;
      reason = 'Ollama 服务不可达：' + e.message;
    }
    return { ...m, channel: 'ollama', online, reason };
  }
  // DSH 命名空间：ollama:qwen3.8:27b / occamy:occamy-1.0 …
  if (typeof modelId === 'string' && modelId.includes(':')) {
    const d = await findDshModel(modelId);
    if (d) {
      const probe = await probeProvider(d.baseURL, d.headers);
      return {
        id: d.id,
        label: d.label,
        tag: d.rawId,
        rawId: d.rawId,
        provider: d.providerId,
        providerLabel: d.displayName,
        channel: 'openai',
        baseURL: d.baseURL,
        headers: d.headers,
        contextWindow: d.contextWindow,
        desc: 'DSH 同步 · ' + d.displayName,
        online: probe.ok,
        reason: probe.reason,
      };
    }
  }
  m = list.find((x) => x.id === cfg.defaultModelId) || list[0];
  if (!m) {
    const e = new Error('未配置任何可用模型');
    e.code = 'LLM_UNAVAILABLE';
    throw e;
  }
  let online = true;
  let reason = null;
  try {
    const tags = await listOllamaModels();
    const names = (tags.models || []).map((t) => t.name);
    if (!names.includes(m.tag)) { online = false; reason = '模型 ' + m.tag + ' 未在 Ollama 中加载'; }
  } catch (e) {
    online = false;
    reason = 'Ollama 服务不可达：' + e.message;
  }
  return { ...m, channel: 'ollama', online, reason };
}

/** OpenAI-compatible /chat/completions 通道（DSH 同步模型走此通道） */
async function openaiChat(opts) {
  const model = opts.model;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || config().ollama.chatTimeoutMs);
  const messages = [
    ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
    ...(opts.messages || []),
  ];
  const body = {
    model: model.rawId || model.tag,
    stream: false,
    messages,
    temperature: opts.temperature ?? 0.3,
  };
  try {
    const res = await fetch(String(model.baseURL).replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(model.headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error('LLM HTTP ' + res.status + '：' + text.slice(0, 300));
      e.code = 'LLM_UNAVAILABLE';
      throw e;
    }
    const data = JSON.parse(text);
    let content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (Array.isArray(content)) content = content.map((c) => (c && c.text) || '').join('');
    // thinking 模型可能输出 <think>…</think>；剥离后取正文
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch (e) {
    if (e.name === 'AbortError') {
      const t = new Error('LLM 请求超时');
      t.code = 'LLM_TIMEOUT';
      throw t;
    }
    if (!e.code) e.code = 'LLM_UNAVAILABLE';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对话补全（按模型通道分发）。
 * @param {object} opts { modelTag, system, messages:[{role,content}], json, timeoutMs }
 *                        或 { model: resolveModel() 结果, system, messages, json, timeoutMs }
 * @returns {string} 助手回复文本
 */
export async function chat(opts) {
  if (opts.model && opts.model.channel === 'openai') {
    return openaiChat(opts);
  }
  const body = {
    model: opts.modelTag || (opts.model && opts.model.tag),
    stream: false,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...(opts.messages || []),
    ],
    options: { temperature: opts.temperature ?? 0.3 },
  };
  if (opts.json) body.format = 'json';
  const data = await ollamaCurl('POST', '/api/chat', body, opts.timeoutMs);
  const msg = data && data.message;
  let content = (msg && msg.content) || '';
  // thinking 模型可能输出 <think>…</think>；剥离后取正文
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return content;
}

/** 快速健康探测（轻量 ping，避免拉起大模型） */
export async function ping() {
  try {
    await listOllamaModels();
    return true;
  } catch {
    return false;
  }
}

export { runCmd };
