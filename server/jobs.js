import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { nowIso } from './util.js';
import { withJobScope, checkCancelled } from './workflow.js';
const jobs = new Map();
function root() { const p = path.join(config().dataDir, 'jobs'); fs.mkdirSync(p, { recursive: true }); return p; }
export function jobView(job) {
  if (!job) return null;
  const { controller, completion, cancelRequested, ...view } = job;
  return view;
}
function save(job) {
  const target = path.join(root(), job.id + '.json'), tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobView(job), null, 2)); fs.renameSync(tmp, target);
}
export function createJob(type, projectId, meta = {}) {
  const job = { id: 'job-' + randomUUID(), type, project_id: projectId || null, meta,
    status: 'queued', step: null, progress: 0, steps: meta.steps || [], timings: [],
    result: null, error: null, created_at: nowIso(), updated_at: nowIso(),
    committed: false, cancelRequested: false, controller: new AbortController() };
  jobs.set(job.id, job); save(job); return job;
}
export function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  try { const job = JSON.parse(fs.readFileSync(path.join(root(), id + '.json'), 'utf8')); jobs.set(id, job); return job; }
  catch { return null; }
}
export function requestCancel(id) {
  const job = getJob(id);
  if (!job) return null;
  if (job.committed || job.committing || job.status === 'done') throw Object.assign(new Error('版本已经提交，无法取消；可回滚版本'), { code: 'INVALID_OPERATION' });
  if (['queued', 'running'].includes(job.status)) {
    job.cancelRequested = true; job.controller?.abort(); job.updated_at = nowIso(); save(job);
  }
  return job;
}
export function startJob(job, runner) {
  job.status = 'running'; job.updated_at = nowIso(); save(job);
  job.completion = withJobScope(job, async () => {
    try {
      checkCancelled();
      const result = await runner(job);
      if (!job.committed) checkCancelled();
      job.status = 'done'; job.result = result ?? null; job.progress = 100;
    } catch (e) {
      job.committing = false;
      job.status = e.code === 'JOB_CANCELLED' || job.cancelRequested ? 'cancelled' : 'failed';
      job.error = { code: e.code || 'JOB_FAILED', message: e.message, recoverable: e.recoverable !== false, next_actions: ['retry'] };
    }
    job.updated_at = nowIso(); job.elapsed_ms = Date.now() - Date.parse(job.created_at); save(job);
  });
  return job;
}
export function setStep(job, step, progress) {
  const now = Date.now();
  if (job.step_started_at) job.timings.push({ step: job.step, duration_ms: now - job.step_started_at });
  job.step = step; job.step_started_at = now;
  job.progress = progress ?? Math.round(step / Math.max(1, job.steps.length) * 95);
  job.updated_at = nowIso(); save(job);
}
export function markInterruptedOnBoot() {
  for (const file of fs.readdirSync(root()).filter((f) => f.endsWith('.json'))) {
    const job = getJob(file.slice(0, -5));
    if (!job || !['queued', 'running'].includes(job.status)) continue;
    job.status = 'interrupted'; job.updated_at = nowIso();
    job.error = { code: 'JOB_INTERRUPTED', message: '宿主中断，请重试；已有版本保留', recoverable: true, next_actions: ['retry'] }; save(job);
    const p = path.join(config().dataDir, 'projects', job.project_id || '', 'project.json');
    if (fs.existsSync(p)) {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (meta.stage === 'generating') { meta.stage = meta.version ? 'done' : 'pages'; meta.active_job = null; fs.writeFileSync(p, JSON.stringify(meta, null, 2)); }
    }
  }
}
export function listJobs(projectId) {
  for (const file of fs.readdirSync(root()).filter((f) => f.endsWith('.json'))) getJob(file.slice(0, -5));
  return [...jobs.values()].filter((j) => !projectId || j.project_id === projectId).sort((a,b) => b.created_at.localeCompare(a.created_at)).map(jobView);
}
export async function cancelProjectJobs(projectId) {
  const active = listJobs(projectId).filter((j) => ['queued', 'running'].includes(j.status));
  for (const view of active) if (!getJob(view.id).committed && !getJob(view.id).committing) requestCancel(view.id);
  await Promise.all(active.map((j) => getJob(j.id).completion).filter(Boolean));
}
