/**
 * 汇文 PPT 后端 · 异步任务注册表（server/jobs.js）
 * build / render / 学习解析等长任务进入后台执行；
 * 每个任务可查询、可取消；宿主重启后 running 任务标记 interrupted（可恢复语义见各任务）。
 * 方案 §14：每个任务可查询、可取消、可恢复。
 */

import { nowIso } from './util.js';

const jobs = new Map();
let seq = 0;

export function createJob(type, projectId, meta = {}) {
  const id = `job-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const job = {
    id, type, project_id: projectId || null,
    status: 'queued', // queued | running | done | failed | cancelled | interrupted
    step: null, progress: 0, steps: meta.steps || [],
    result: null, error: null,
    created_at: nowIso(), updated_at: nowIso(),
    cancelRequested: false,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function requestCancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') job.cancelRequested = true;
  return job;
}

/** 运行任务主体；runner 收到 job，可随时检查 job.cancelRequested */
export function startJob(job, runner) {
  job.status = 'running';
  job.updated_at = nowIso();
  (async () => {
    try {
      const result = await runner(job);
      if (job.cancelRequested) {
        job.status = 'cancelled';
      } else {
        job.status = 'done';
        job.result = result ?? null;
        job.progress = 100;
      }
    } catch (e) {
      job.status = 'failed';
      job.error = { code: e.code || 'JOB_FAILED', message: e.message, recoverable: e.recoverable !== false, next_actions: e.next_actions || [] };
    }
    job.updated_at = nowIso();
  })();
  return job;
}

export function setStep(job, step, progress) {
  job.step = step;
  if (progress != null) job.progress = Math.max(0, Math.min(99, progress));
  job.updated_at = nowIso();
}

/** 宿主重启后调用：没有进程能继续的任务标记 interrupted */
export function markInterruptedOnBoot() {
  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'interrupted';
      job.error = { code: 'JOB_INTERRUPTED', message: '插件进程重启，任务中断；可重试', recoverable: true, next_actions: ['retry'] };
    }
  }
}

export function jobView(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  return rest;
}

export function listJobs(projectId) {
  const all = [...jobs.values()].filter((j) => !projectId || j.project_id === projectId);
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(jobView);
}
