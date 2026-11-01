/**
 * 汇文 PPT 后端 · 通用工具（server/util.js）
 * 契约：ESM；仅 node: 内置模块；不引入任何 npm 依赖。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { operationSignal } from './workflow.js';

/** 文件 SHA256（小写 hex） */
export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function shortSha(sha) {
  return sha && sha.length > 12 ? sha.slice(0, 8) + '…' + sha.slice(-4) : String(sha || '');
}

export function nowIso() {
  return new Date().toISOString();
}

export function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** JSON 读取；不存在或损坏返回 fallback（损坏时在日志里可见） */
export async function readJson(p, fallback = null) {
  try {
    const txt = await fsp.readFile(p, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/** 原子写 JSON（tmp + rename，防半截文件） */
export async function writeJson(p, data) {
  await fsp.mkdir(path.dirname(String(p)), { recursive: true });
  const tmp = String(p) + '.tmp-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(tmp, JSON.stringify(data, ensurePlain(data), 2), 'utf8');
  await fsp.rename(tmp, String(p));
}

function ensurePlain(data) {
  // writeJson 的 replacer：丢掉 undefined，保持 JSON 稳定
  return (k, v) => (v === undefined ? null : v);
}

/** 追加一行 JSONL（conversation.jsonl 等用） */
export async function appendJsonl(p, obj) {
  await fsp.mkdir(path.dirname(String(p)), { recursive: true });
  await fsp.appendFile(p, JSON.stringify(obj) + '\n', 'utf8');
}

export async function readJsonl(p) {
  let txt = '';
  try { txt = await fsp.readFile(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过损坏行 */ }
  }
  return out;
}

/** execFile 包装：超时 + 截断输出 */
export function runCmd(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd, signal: opts.signal || operationSignal() },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, err, stdout: stdout || '', stderr: stderr || '', killed: Boolean(err && err.killed) });
      });
  });
}

/** 读取请求体（上限保护） */
export function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('请求体超过大小限制'), { code: 'PAYLOAD_TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'INVALID_OPERATION' }); }
}

/** 路径安全拼接：结果必须落在 root 内，否则抛错 */
export function safeJoin(root, rel) {
  const r = path.resolve(String(root));
  const t = path.resolve(r, String(rel || '.'));
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw Object.assign(new Error('路径越界：' + rel), { code: 'FORBIDDEN' });
  }
  return t;
}

/** 稳定字符串哈希（索引用） */
export function stableHash(obj) {
  return sha256Buf(Buffer.from(JSON.stringify(obj)));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 统一错误对象（方案 §13 错误信封） */
export function apiError(code, message, details, recoverable = true, nextActions = []) {
  return { ok: false, code, message, details: details || null, recoverable, next_actions: nextActions };
}
