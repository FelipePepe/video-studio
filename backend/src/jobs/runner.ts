import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ApproveOptions } from '../pipeline/types';
import type { EventHub } from './eventHub';
import {
  createJob,
  failInterruptedJobs,
  getJob,
  markCancelled,
  markDone,
  markFailed,
  markRunning,
  updateJob,
  type Clock,
} from './jobRepository';
import type { EmitInput, ExecuteFn, Job, JobContext, JobEvent } from './types';

export interface JobRunnerOptions {
  db: DatabaseSync;
  hub: EventHub;
  execute: ExecuteFn;
  workDir: string;
  clock?: Clock;
  /** How long the hub keeps a finished job's replay buffer. Default 60 s. */
  clearGraceMs?: number;
}

export const unconfiguredExecute: ExecuteFn = async () => {
  throw new Error('pipeline not configured');
};

export class JobRunner {
  readonly workDir: string;
  private readonly db: DatabaseSync;
  private readonly hub: EventHub;
  private readonly execute: ExecuteFn;
  private readonly clock: Clock;
  private readonly clearGraceMs: number;
  private readonly queue: string[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private current: { id: string; controller: AbortController } | undefined;
  private started = false;
  private draining = false;

  constructor(opts: JobRunnerOptions) {
    this.db = opts.db;
    this.hub = opts.hub;
    this.execute = opts.execute;
    this.workDir = opts.workDir;
    this.clock = opts.clock ?? (() => new Date());
    this.clearGraceMs = opts.clearGraceMs ?? 60_000;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    failInterruptedJobs(this.db, this.clock);
    this.kick();
  }

  /** Writes the queued job row only, so it can join an outer transaction. Call `schedule` after COMMIT. */
  createJob(draftId: string, opts: ApproveOptions | null = null): Job {
    return createJob(this.db, draftId, this.clock, randomUUID, opts);
  }

  schedule(job: Job): void {
    this.queue.push(job.id);
    this.kick();
  }

  enqueue(draftId: string): Job {
    const job = this.createJob(draftId);
    this.schedule(job);
    return job;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = getJob(this.db, jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      const i = this.queue.indexOf(jobId);
      if (i >= 0) this.queue.splice(i, 1);
      markCancelled(this.db, jobId, this.clock);
      this.publish({ type: 'cancelled', jobId });
      this.scheduleClear(jobId);
      return true;
    }
    if (job.status === 'running' && this.current?.id === jobId) {
      this.current.controller.abort();
      return true;
    }
    return false;
  }

  idle(): Promise<void> {
    if (!this.draining && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private kick(): void {
    if (!this.started || this.draining) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    for (;;) {
      const id = this.queue.shift();
      if (!id) break;
      try {
        await this.runOne(id);
      } catch (e) {
        console.error(`job ${id} runner error`, e);
      }
    }
    this.draining = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private publish(partial: EmitInput & { jobId: string }): void {
    this.hub.publish({ ...partial, at: this.clock().toISOString() } as JobEvent);
  }

  private scheduleClear(jobId: string): void {
    setTimeout(() => this.hub.clear(jobId), this.clearGraceMs).unref();
  }

  private async runOne(id: string): Promise<void> {
    const queued = getJob(this.db, id);
    if (!queued || queued.status !== 'queued') return;
    const controller = new AbortController();
    this.current = { id, controller };
    let settled = false;
    try {
      const job = markRunning(this.db, id, this.clock) as Job;
      const workDir = join(this.workDir, id);
      mkdirSync(workDir, { recursive: true });
      const ctx: JobContext = {
        signal: controller.signal,
        workDir,
        emit: (partial) => {
          if (settled) return;
          if (partial.stage !== undefined || partial.progress !== undefined) {
            updateJob(this.db, id, { stage: partial.stage, progress: partial.progress }, this.clock);
          }
          this.publish({ ...partial, jobId: id });
        },
      };
      try {
        const { outputPath } = await this.execute(job, ctx);
        settled = true;
        if (controller.signal.aborted) this.finishCancelled(id);
        else {
          markDone(this.db, id, outputPath, this.clock);
          this.publish({ type: 'done', jobId: id, progress: 1, outputUrl: `/api/jobs/${id}/output` });
        }
      } catch (e) {
        settled = true;
        if (controller.signal.aborted) this.finishCancelled(id);
        else {
          const message = e instanceof Error ? e.message : String(e);
          markFailed(this.db, id, message, this.clock);
          this.publish({ type: 'error', jobId: id, message });
        }
      }
    } catch (e) {
      settled = true;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`job ${id} failed to run`, e);
      try {
        markFailed(this.db, id, message, this.clock);
        this.publish({ type: 'error', jobId: id, message });
      } catch (inner) {
        console.error(`job ${id} could not be marked failed`, inner);
      }
    } finally {
      this.current = undefined;
      this.scheduleClear(id);
    }
  }

  private finishCancelled(id: string): void {
    markCancelled(this.db, id, this.clock);
    this.publish({ type: 'cancelled', jobId: id });
  }
}
