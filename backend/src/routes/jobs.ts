import { realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Router, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { EventHub } from '../jobs/eventHub';
import { deleteJob, getJob, listJobs } from '../jobs/jobRepository';
import type { JobRunner } from '../jobs/runner';
import { TERMINAL_EVENT_TYPES, type Job, type JobEvent, type JobStatus } from '../jobs/types';

export interface JobsDeps {
  db: DatabaseSync;
  runner: JobRunner;
  hub: EventHub;
  heartbeatMs?: number;
}

const STATUSES: ReadonlySet<string> = new Set<JobStatus>(['queued', 'running', 'done', 'failed', 'cancelled']);
const MAX_LIMIT = 200;

function snapshotEvent(job: Job): JobEvent {
  const base = { jobId: job.id, stage: job.stage, progress: job.progress, at: job.updatedAt };
  if (job.status === 'done') return { ...base, type: 'done', outputUrl: `/api/jobs/${job.id}/output` };
  if (job.status === 'failed') return { ...base, type: 'error', message: job.error ?? 'failed' };
  if (job.status === 'cancelled') return { ...base, type: 'cancelled' };
  return { ...base, type: job.stage ? 'stage' : 'progress' };
}

function writeEvent(res: Response, event: JobEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function resolveOutput(workDir: string, outputPath: string): { root: string; rel: string } | 'outside' | 'missing' {
  try {
    const root = realpathSync(resolve(workDir));
    const real = realpathSync(resolve(outputPath));
    const rel = relative(root, real);
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return 'outside';
    if (!statSync(real).isFile()) return 'missing';
    return { root, rel };
  } catch {
    // realpath fails for missing files; a lexical check still tells outside from missing.
    const rel = relative(resolve(workDir), resolve(outputPath));
    return rel.startsWith('..') || isAbsolute(rel) ? 'outside' : 'missing';
  }
}

export interface StreamDeps {
  hub: EventHub;
  heartbeatMs?: number;
}

/**
 * Streams a job's events as SSE until its terminal event. `prelude` is written first
 * and replaces the snapshot fallback when the hub has nothing buffered. Closing the
 * connection only unsubscribes; it never affects the job.
 */
export function streamJobEvents(res: Response, deps: StreamDeps, job: Job, prelude?: JobEvent): void {
  const { hub, heartbeatMs = 15_000 } = deps;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    heartbeat = undefined;
    unsubscribe = undefined;
  };
  const send = (event: JobEvent) => {
    if (res.writableEnded) return;
    writeEvent(res, event);
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      close();
      res.end();
    }
  };
  res.on('close', close);

  if (prelude) send(prelude);
  const buffered = hub.replay(job.id);
  const initial = buffered.length > 0 ? buffered : prelude ? [] : [snapshotEvent(job)];
  for (const event of initial) send(event);
  if (res.writableEnded) return;
  // Replay and subscribe happen in the same tick, so no event can fall between them.
  unsubscribe = hub.subscribe(job.id, send);
  heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  heartbeat.unref();
}

export function jobsRouter(deps: JobsDeps): Router {
  const { db, runner, hub, heartbeatMs = 15_000 } = deps;
  const router = Router();

  router.get('/', (req, res) => {
    const { status, limit } = req.query;
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }
    let max: number | undefined;
    if (limit !== undefined) {
      max = typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : NaN;
      if (!Number.isInteger(max) || max < 1 || max > MAX_LIMIT) {
        res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
        return;
      }
    }
    res.json(listJobs(db, { limit: max, status: status as JobStatus | undefined }));
  });

  router.get('/:id', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  router.get('/:id/events', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    streamJobEvents(res, { hub, heartbeatMs }, job);
  });

  router.post('/:id/cancel', async (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status !== 'queued' && job.status !== 'running') {
      res.status(409).json({ error: `Job already ${job.status}` });
      return;
    }
    res.json({ cancelled: await runner.cancel(job.id) });
  });

  router.delete('/:id', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    // Only terminal jobs can be deleted; cancelling a live job is a separate, explicit act.
    if (job.status === 'queued' || job.status === 'running') {
      res.status(409).json({ error: `Job is ${job.status}; cancel it before deleting` });
      return;
    }
    const deleted = deleteJob(db, job.id);
    if (deleted === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    // Best-effort cleanup of the job's workDir (artifacts, cache). A failure here must not
    // fail the delete — retention will reap any stragglers. The draft is intentionally kept.
    try {
      rmSync(join(runner.workDir, job.id), { recursive: true, force: true });
    } catch {
      /* ignore best-effort workdir removal errors */
    }
    hub.clear(job.id);
    res.json({ deleted: true });
  });

  router.get('/:id/output', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job || job.status !== 'done' || !job.outputPath) {
      res.status(404).json({ error: 'Output not available' });
      return;
    }
    const variant = req.query.variant;
    let rel = job.outputPath;
    let contentType = 'video/mp4';
    if (variant !== undefined) {
      if (variant !== 'vertical' && variant !== 'cover') {
        res.status(400).json({ error: "variant must be 'vertical' or 'cover'" });
        return;
      }
      const dir = dirname(job.outputPath);
      if (variant === 'vertical') {
        rel = join(dir, 'final_v.mp4');
      } else {
        rel = join(dir, 'cover.jpg');
        contentType = 'image/jpeg';
      }
    }
    const target = resolveOutput(runner.workDir, rel);
    if (target === 'outside') {
      res.status(403).json({ error: 'Output path is outside the work directory' });
      return;
    }
    if (target === 'missing') {
      res.status(404).json({ error: 'Output file not found' });
      return;
    }
    res.type(contentType);
    res.sendFile(target.rel, { root: target.root }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Output file not found' });
    });
  });

  return router;
}
