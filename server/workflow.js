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
  const operation=scope.getStore()?.pptOperation;
  if(!operation||operation.corrected) return false;
  const admission=modelBudget()?.requestCorrection;
  if(admission&&!await admission({reason})) return false;
  operation.corrected=true;
  return true;
}
