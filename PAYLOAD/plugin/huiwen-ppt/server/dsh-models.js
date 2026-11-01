/**
 * 汇文 PPT 后端 · DSH 模型同步（server/dsh-models.js）
 * 数据源：DSH web profile 的 cordis.patch.yml（llm-pi-ai 插件 config.providers），
 * 使对话页模型下拉框与 DSH 模型保持一致。
 *
 * 同步约定（2026-10-11 与用户确认）：
 *   - 只同步本地 provider（baseURL 为 127.0.0.1 / localhost / [::1]）；云端（tokenstore/sol）二期接入；
 *   - 过滤 embedding 等不可对话模型；
 *   - 模型 ID 命名空间：`${providerId}:${模型原始 id}`，如 `ollama:qwen3.8:27b`；
 *   - 按补丁文件 mtime + TTL 缓存：DSH 增删模型后 huiwen 无需重启即自动跟随。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const patchPath = () => process.env.DSH_PATCH_PATH || (process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  : path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'));
const CACHE_TTL = 15000;          // 列表缓存：15s 内不重复读盘
const PROBE_TTL = 15000;          // provider 连通性缓存
const LOCAL_RX = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
// 不可对话模型（embedding / 语音 / 重排等）：按 id + name 过滤
const NON_CHAT_RX = /embed|embedding|bge[-_]|nomic|rerank|whisper|\btts\b|speech/i;

/* ── YAML 库加载：优先复用环境内 js-yaml / yaml，失败回退内置迷你解析器 ── */

let yamlLib = undefined; // undefined=未探测；null=探测过且不可用

function tryLoadYamlLib() {
  if (yamlLib !== undefined) return yamlLib;
  const req = createRequire(import.meta.url);
  const candidates = [
    'js-yaml',
    'yaml',
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web', 'node_modules', 'js-yaml'),
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules', 'js-yaml'),
    '/home/lgsj/.dsh/profiles/web/node_modules/.pnpm/js-yaml@4.3.2/node_modules/js-yaml',
    '/home/lgsj/deepseek-harness.dsh-v0.1.7-alpha.2/node_modules/js-yaml',
  ];
  for (const c of candidates) {
    try { yamlLib = req(c); return yamlLib; } catch { /* 下一个 */ }
  }
  yamlLib = null;
  return null;
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith("'") && t.endsWith("'") && t.length >= 2) || (t.startsWith('"') && t.endsWith('"') && t.length >= 2)) {
    return t.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  return t;
}

function parseScalar(raw) {
  const t = String(raw).trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  // 裸值去行内注释（带引号的值不动）：`value  # note` → `value`
  const stripped = (t.startsWith("'") || t.startsWith('"')) ? t : t.replace(/\s+#.*$/, '');
  return unquote(stripped);
}

/**
 * 迷你 YAML 子集解析器（仅覆盖 cordis.patch.yml 的结构，作为 js-yaml 不可用时的兜底）：
 * 顶层列表 / 嵌套映射 / 块列表（含与键同缩进的列表）/ 引号与裸标量 / 整数布尔。
 * 不支持锚点、多行字面量（| >）、流式集合——补丁文件用不到。
 */
export function miniYamlParse(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const noTab = raw.replace(/\t/g, '  ');
    const m = noTab.match(/^(\s*)(.*)$/);
    const body = m[2];
    if (body === '' || body.startsWith('#')) continue;
    lines.push({ indent: m[1].length, body });
  }
  let pos = 0;
  // 闭包内使用可变绑定（parseFromLines 需要临时换行集）
  let buf = lines;

  function isItem(line) { return line && (line.body.startsWith('- ') || line.body === '-'); }

  function parseBlock(indent) {
    if (pos >= buf.length) return null;
    const first = buf[pos];
    if (first.indent < indent) return null;
    if (isItem(first)) return parseList(first.indent);
    return parseMap(first.indent);
  }

  function parseList(indent) {
    const arr = [];
    while (pos < buf.length) {
      const line = buf[pos];
      if (line.indent !== indent || !isItem(line)) break;
      const rest = line.body === '-' ? '' : line.body.slice(2);
      pos += 1;
      if (rest === '') {
        // `- ` 后内容在更深层
        if (pos < buf.length && buf[pos].indent > indent) arr.push(parseBlock(buf[pos].indent));
        else arr.push(null);
      } else if (/^[^:#]+:(\s|$)/.test(rest) || /^[^:]+:$/.test(rest)) {
        // `- key: value`：首键并入子映射；后续内容缩进取实际下一行深度
        const contIndent = (pos < buf.length && buf[pos].indent > indent) ? buf[pos].indent : indent + 2;
        const sub = [{ indent: contIndent, body: rest }];
        while (pos < buf.length && buf[pos].indent >= contIndent) {
          sub.push(buf[pos]); pos += 1;
        }
        arr.push(parseFromLines(sub, contIndent));
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < buf.length) {
      const line = buf[pos];
      if (line.indent !== indent) break;
      if (isItem(line)) break;
      const m = line.body.match(/^([^:]+):(.*)$/);
      if (!m) break;
      const key = unquote(m[1].trim());
      const rest = m[2].trim();
      pos += 1;
      if (rest === '') {
        if (pos < buf.length && buf[pos].indent > indent) {
          obj[key] = parseBlock(buf[pos].indent);
        } else if (pos < buf.length && buf[pos].indent === indent && isItem(buf[pos])) {
          // YAML 允许块列表与键同缩进（cordis.patch.yml 的 models 正是这种）
          obj[key] = parseList(indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  // 从已捕获的行数组解析子映射（供 `- key: value` 复用；行内缩进保持原值）
  function parseFromLines(sub, baseIndent) {
    const savedBuf = buf, savedPos = pos;
    buf = sub; pos = 0;
    try {
      return parseMap(baseIndent);
    } finally {
      buf = savedBuf; pos = savedPos;
    }
  }

  return parseBlock(0);
}

/* ── 补丁解析：提取 providers ── */

export function parseDshProviders(doc) {
  const out = [];
  const entries = Array.isArray(doc) ? doc : [doc];
  for (const entry of entries) {
    const provs = entry && entry.config && entry.config.providers;
    if (!provs || typeof provs !== 'object') continue;
    for (const [pid, p] of Object.entries(provs)) {
      if (!p || typeof p !== 'object' || !p.baseURL) continue;
      out.push({
        id: pid,
        displayName: p.displayName || pid,
        api: p.api || 'openai-completions',
        baseURL: String(p.baseURL),
        headers: (p.headers && typeof p.headers === 'object') ? { ...p.headers } : {},
        rawModels: Array.isArray(p.models) ? p.models.filter((m) => m && m.id) : [],
      });
    }
  }
  return out;
}

function isLocal(baseURL) { return LOCAL_RX.test(baseURL); }
function isChatModel(m) {
  const s = `${m.id || ''} ${m.name || ''}`;
  return !NON_CHAT_RX.test(s);
}

/* ── 对外：本地可对话模型列表（mtime + TTL 缓存，自动跟随 DSH 变更） ── */

let cache = { path: null, mtimeMs: -1, at: 0, providers: [] };

export async function getDshLocalModels() {
  const source = patchPath();
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(source).mtimeMs; } catch { return []; }
  if (cache.providers.length && cache.path === source && cache.mtimeMs === mtimeMs && Date.now() - cache.at < CACHE_TTL) {
    return cache.providers;
  }
  let providers = [];
  try {
    const text = fs.readFileSync(source, 'utf8');
    const yaml = tryLoadYamlLib();
    const doc = yaml && typeof yaml.load === 'function' ? yaml.load(text) : miniYamlParse(text);
    providers = parseDshProviders(doc)
      .filter((p) => isLocal(p.baseURL))
      .map((p) => ({
        ...p,
        models: p.rawModels.filter(isChatModel).map((m) => ({
          id: `${p.id}:${m.id}`,          // 全局命名空间：ollama:qwen3.8:27b
          rawId: m.id,                     // provider 内原始 id
          label: m.name || m.id,
          contextWindow: m.contextWindow || null,
        })),
      }))
      .filter((p) => p.models.length > 0);
  } catch {
    providers = [];
  }
  cache = { path: source, mtimeMs, at: Date.now(), providers };
  return providers;
}

/** 按 DSH 命名空间 ID 查找模型（如 ollama:qwen3.8:27b）；找不到返回 null */
export async function findDshModel(modelId) {
  const providers = await getDshLocalModels();
  for (const p of providers) {
    const m = p.models.find((x) => x.id === modelId);
    if (m) return { ...m, providerId: p.id, displayName: p.displayName, baseURL: p.baseURL, headers: p.headers };
  }
  return null;
}

/* ── provider 连通性探测（GET {baseURL}/models，缓存 15s） ── */

const probeCache = new Map(); // baseURL -> { at, ok, reason }

export async function probeProvider(baseURL, headers) {
  const hit = probeCache.get(baseURL);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit;
  let result = { ok: false, reason: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(baseURL.replace(/\/$/, '') + '/models', {
      method: 'GET',
      headers: { ...(headers || {}) },
      signal: ctrl.signal,
    });
    if (res.ok) result = { ok: true, reason: null };
    else result = { ok: false, reason: 'HTTP ' + res.status };
  } catch (e) {
    result = { ok: false, reason: e.name === 'AbortError' ? '探测超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
  probeCache.set(baseURL, { at: Date.now(), ...result });
  return result;
}
