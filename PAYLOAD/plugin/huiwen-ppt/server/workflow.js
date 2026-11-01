import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
const tails = new Map();
export function withModelBudget(budget, fn) { const parent=scope.getStore()||{}; return scope.run({ ...parent, modelBudget:budget, pptOperation:parent.pptOperation||{corrected:false} },fn); }
export function modelBudget() { return scope.getStore()?.modelBudget; }
export async function withProjectLock(id, fn) {
  const parent = scope.getStore() || {};
  if (parent.lock === id) return fn();
  const previous = tails.get(id) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => next);
  tails.set(id, tail);
  await previous.catch(() => {});
  try { return await scope.run({ ...parent, lock: id }, fn); }
  finally { release(); if (tails.get(id) === tail) tails.delete(id); }
}
export function withJobScope(job, fn) { return scope.run({ ...(scope.getStore() || {}), lock: undefined, job, pptOperation:scope.getStore()?.pptOperation||{corrected:false} }, fn); }
export function operationSignal() { return scope.getStore()?.job?.controller?.signal; }
export function operationJob() { return scope.getStore()?.job; }
export function checkCancelled() {
  if (operationSignal()?.aborted) throw Object.assign(new Error('任务已取消，未提交版本'), { code: 'JOB_CANCELLED' });
}
export function beginCommit() { checkCancelled(); const job=scope.getStore()?.job; if(job)job.committing=true; }
export function markCommitted() { const job = scope.getStore()?.job; if (job) { job.committed = true; job.committing=false; } }

export function withPptOperation(fn) {
  const parent=scope.getStore()||{};
  return parent.pptOperation?fn():scope.run({...parent,pptOperation:{corrected:false}},fn);
}
export async function requestPptCorrection(reason) {
  checkCancelled();
  const admission=modelBudget()?.requestCorrection;
  if(admission&&!await admission({reason})) return false;
  // Each caller already bounds retries for its current input; separate pages may each need a repair.
  return true;
}

export async function resolveProductionIntent(projectId, message) {
  const {loadProject} = await import('./projects.js');
  const {listMaterials} = await import('./materials.js');
  const {meta} = await loadProject(projectId);
  const text = String(message || '').trim();
  const count = text.match(/(-?\d+(?:\.\d+)?)\s*页/);
  const requested_page_count = count ? Number(count[1]) : null;
  if (count && (!Number.isInteger(requested_page_count) || requested_page_count < 1 || requested_page_count > 500)) throw Object.assign(new Error('页数必须为1–500的整数；超过实际构建范围请拆分'),{code:'INVALID_OPERATION'});
  const instruction=text.split(/\r?\n/).filter(line=>!/^\s*[|>]/.test(line)).join('\n');
  const clean = instruction.replace(/(?:不用|无需|不要|不需要|不必)[^，。；\n]{0,8}(?:样张|大纲)/g,'');
  const mode = /先(?:看|出|给|做|生成).{0,5}大纲/.test(clean) ? 'outline' : /先(?:看|出|给|做|生成).{0,5}样张/.test(clean) ? 'sample' :
    ['outline','generating'].includes(meta.stage) && (meta.pending_production_mode||meta.production_mode)==='outline' && !/(?:确认|继续|开始).{0,12}(?:生成|制作|全稿|PPT)/.test(clean) ? 'outline' : 'compose';
  return {mode, needs_input:!text && !(await listMaterials(projectId)).length, selection:meta.pending_selection || meta.template_selection || null, requested_page_count};
}
