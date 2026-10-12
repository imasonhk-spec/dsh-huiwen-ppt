/**
 * 汇文 PPT 后端 · studio.py CLI 包装（server/studio.js）
 * studio.py 是核心能力来源（纯标准库 OOXML）；本模块只做进程包装与错误映射。
 * 输出约定：命令成功在 stdout 打印 JSON；失败在 stderr 打印 {"error": "..."}。
 */

import path from 'node:path';
import { config } from './config.js';
import { runCmd } from './util.js';

const TIMEOUT = 180000;

/** studio.py 脚本绝对路径 */
export function studioScript() {
  return path.join(config().skillDir, 'scripts', 'studio.py');
}

/** 错误消息 → 方案 §13 错误码 */
export function mapStudioError(msg) {
  const m = String(msg || '');
  if (/SHA256|mismatch|hash/i.test(m)) return 'SOURCE_HASH_MISMATCH';
  if (/not found|不存在|No such file/i.test(m)) return 'SOURCE_NOT_FOUND';
  if (/must be confirmed|approval|确认/i.test(m)) return 'TEMPLATE_NOT_APPROVED';
  if (/missing|required field|Provide/i.test(m)) return 'REQUIRED_FIELD_MISSING';
  if (/Unsupported|unsupported|not supported/i.test(m)) return 'UNSUPPORTED_OBJECT';
  if (/ambiguous|Expected one text match/i.test(m)) return 'INVALID_OPERATION';
  return 'ENGINE_FAILED';
}

/** 运行 studio.py 子命令，返回解析后的 JSON 结果 */
export async function studio(args, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT;
  const r = await runCmd(config().python, [studioScript(), ...args], { timeoutMs });
  const out = (r.stdout || '').trim();
  const errT = (r.stderr || '').trim();
  if (r.code !== 0 || (!out && errT)) {
    let msg = errT || out || ('studio.py 退出码 ' + r.code);
    try { msg = JSON.parse(errT).error || msg; } catch { /* 保留原文 */ }
    const e = new Error(msg);
    e.code = mapStudioError(msg);
    e.recoverable = true;
    throw e;
  }
  if (!out) return {};
  try { return JSON.parse(out); } catch {
    const e = new Error('studio.py 输出不是合法 JSON');
    e.code = 'ENGINE_FAILED';
    throw e;
  }
}

/* ── 领域命令封装 ─────────────────────────────────────────────── */

export const inspectSource = (source, output) => studio(['inspect', '--source', source, '--output', output]);

export const registerTemplate = (source, library, name) => studio(['register', '--source', source, '--library', library, '--name', name]);

export const listTemplates = (library) => studio(['list', '--library', library]);

export const approveTemplate = (template, confirmedBy, note) =>
  studio(['approve-template', '--template', template, '--confirmed-by', confirmedBy, '--note', note]);

export const createProject = (source, project) => studio(['project', '--source', source, '--project', project]);

export const patchSource = (source, patchFile, output) => studio(['patch', '--source', source, '--patch', patchFile, '--output', output]);

export const buildDeck = (template, plan, output) => studio(['build', '--template', template, '--plan', plan, '--output', output]);

export const importRevision = (source, project, expectedSha, engine) =>
  studio(['import-revision', '--source', source, '--project', project, '--expected-sha256', expectedSha, '--engine', engine]);

export const addKnowledge = (library, itemFile, confirmedBy) =>
  studio(['knowledge', '--library', library, '--item', itemFile, '--confirmed-by', confirmedBy]);
