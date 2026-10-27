import type { MailMoveJob, StoredMailMoveJob } from './types';

export const activeMoveJob = (job: MailMoveJob) =>
  job.status === 'queued' || job.status === 'running';

export function summarizeMove(job: StoredMailMoveJob, now: Date): StoredMailMoveJob {
  const completed = job.items.filter((item) => item.status === 'completed').length;
  const failed = job.items.filter(
    (item) => item.status === 'failed' || item.status === 'uncertain',
  ).length;
  const cancelled = job.items.filter((item) => item.status === 'cancelled').length;
  const running = job.items.some((item) => item.status === 'running');
  const queued = job.items.some((item) => item.status === 'queued');
  let status: MailMoveJob['status'] = 'failed';
  if (running) status = 'running';
  else if (queued) status = 'queued';
  else if (completed === job.total) status = 'completed';
  else if (cancelled === job.total) status = 'cancelled';
  else if (completed || cancelled) status = 'partial';
  return {
    ...job,
    completed,
    failed,
    status,
    updatedAt: now.toISOString(),
  };
}

export function publicMoveJob(job: StoredMailMoveJob): MailMoveJob {
  return {
    id: job.id,
    status: job.status,
    folderName: job.folderName,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    items: job.items.map(({ revision: _revision, ...item }) => item),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
