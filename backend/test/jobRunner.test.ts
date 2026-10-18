import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection';
import { createDraft } from '../src/pipeline/draftRepository';
import { createJob, getJob, markRunning } from '../src/jobs/jobRepository';
import { EventHub } from '../src/jobs/eventHub';
import { JobRunner } from '../src/jobs/runner';
import type { ExecuteFn, JobEvent } from '../src/jobs/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(execute: ExecuteFn) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-runner-'));
  dirs.push(workDir);
  const db = openDatabase(':memory:');
  const draft = createDraft(db, {
    sourceKind: 'text',
    sourceRef: 'x',
    language: 'es',
    voiceA: 'male',
    voiceB: 'female',
    mix: false,
    escaleta: [],
  });
  const hub = new EventHub();
  const runner = new JobRunner({ db, hub, execute, workDir, clearGraceMs: 0 });
  return { db, hub, runner, workDir, draftId: draft.id };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test('runs queued jobs one at a time in FIFO order and marks them done', async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const { runner, db, draftId } = setup(async (job, ctx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(job.id);
    await tick();
    active--;
    return { outputPath: join(ctx.workDir, 'out.mp4') };
  });
  runner.start();
  const ids = [runner.enqueue(draftId).id, runner.enqueue(draftId).id, runner.enqueue(draftId).id];
  await runner.idle();
  assert.deepEqual(order, ids);
  assert.equal(maxActive, 1);
  for (const id of ids) {
    const job = getJob(db, id);
    assert.equal(job?.status, 'done');
    assert.equal(job?.outputPath, join(runner.workDir, id, 'out.mp4'));
    assert.ok(job?.startedAt && job.finishedAt);
  }
});

test('creates <workDir>/<jobId> before execute and publishes a done event with outputUrl', async () => {
  let dirExisted = false;
  const { runner, hub, draftId } = setup(async (_job, ctx) => {
    dirExisted = existsSync(ctx.workDir);
    return { outputPath: join(ctx.workDir, 'o.mp4') };
  });
  runner.start();
  const job = runner.enqueue(draftId);
  const events: JobEvent[] = [];
  hub.subscribe(job.id, (e) => events.push(e));
  await runner.idle();
  assert.equal(dirExisted, true);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done?.outputUrl, `/api/jobs/${job.id}/output`);
  assert.equal(done?.jobId, job.id);
  assert.ok(done?.at);
});

test('a failing execute marks the job failed and publishes an error event', async () => {
  const { runner, hub, db, draftId } = setup(async () => {
    throw new Error('kaput');
  });
  runner.start();
  const job = runner.enqueue(draftId);
  const events: JobEvent[] = [];
  hub.subscribe(job.id, (e) => events.push(e));
  await runner.idle();
  assert.equal(getJob(db, job.id)?.status, 'failed');
  assert.equal(getJob(db, job.id)?.error, 'kaput');
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(events.at(-1)?.message, 'kaput');
});

test('a throwing execute does not stop the next job', async () => {
  let calls = 0;
  const { runner, db, draftId } = setup(async (_job, ctx) => {
    if (++calls === 1) throw new Error('first dies');
    return { outputPath: join(ctx.workDir, 'o.mp4') };
  });
  runner.start();
  const a = runner.enqueue(draftId);
  const b = runner.enqueue(draftId);
  await runner.idle();
  assert.equal(getJob(db, a.id)?.status, 'failed');
  assert.equal(getJob(db, b.id)?.status, 'done');
});

test('emit persists stage and progress and publishes events', async () => {
  const gate = deferred();
  const { runner, hub, db, draftId } = setup(async (_job, ctx) => {
    ctx.emit({ type: 'stage', stage: 'tts' });
    ctx.emit({ type: 'progress', progress: 0.4 });
    await gate.promise;
    return { outputPath: join(ctx.workDir, 'o.mp4') };
  });
  runner.start();
  const job = runner.enqueue(draftId);
  await tick();
  const mid = getJob(db, job.id);
  assert.equal(mid?.status, 'running');
  assert.equal(mid?.stage, 'tts');
  assert.equal(mid?.progress, 0.4);
  assert.deepEqual(hub.replay(job.id).map((e) => e.type), ['stage', 'progress']);
  gate.resolve();
  await runner.idle();
});

test('cancel on a queued job marks it cancelled without running it', async () => {
  const gate = deferred();
  const ran: string[] = [];
  const { runner, db, hub, draftId } = setup(async (job, ctx) => {
    ran.push(job.id);
    await gate.promise;
    return { outputPath: join(ctx.workDir, 'o.mp4') };
  });
  runner.start();
  const first = runner.enqueue(draftId);
  const second = runner.enqueue(draftId);
  const events: JobEvent[] = [];
  hub.subscribe(second.id, (e) => events.push(e));
  await tick();
  assert.equal(await runner.cancel(second.id), true);
  assert.equal(getJob(db, second.id)?.status, 'cancelled');
  assert.equal(events.at(-1)?.type, 'cancelled');
  gate.resolve();
  await runner.idle();
  assert.deepEqual(ran, [first.id]);
  assert.equal(getJob(db, second.id)?.status, 'cancelled');
});

test('cancel on the running job aborts its signal and ends cancelled', async () => {
  let aborted = false;
  const started = deferred();
  const { runner, db, hub, draftId } = setup((_job, ctx) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  });
  runner.start();
  const job = runner.enqueue(draftId);
  const events: JobEvent[] = [];
  hub.subscribe(job.id, (e) => events.push(e));
  await started.promise;
  assert.equal(await runner.cancel(job.id), true);
  await runner.idle();
  assert.equal(aborted, true);
  assert.equal(getJob(db, job.id)?.status, 'cancelled');
  assert.equal(events.at(-1)?.type, 'cancelled');
  assert.ok(!events.some((e) => e.type === 'error'));
});

test('cancel returns false for unknown or finished jobs', async () => {
  const { runner, draftId } = setup(async (_j, ctx) => ({ outputPath: join(ctx.workDir, 'o.mp4') }));
  runner.start();
  const job = runner.enqueue(draftId);
  await runner.idle();
  assert.equal(await runner.cancel(job.id), false);
  assert.equal(await runner.cancel('missing'), false);
});

test('start fails jobs left running or queued by a previous process', async () => {
  const { runner, db, draftId } = setup(async (_j, ctx) => ({ outputPath: join(ctx.workDir, 'o.mp4') }));
  const stale = createJob(db, draftId);
  markRunning(db, stale.id);
  runner.start();
  await runner.idle();
  assert.equal(getJob(db, stale.id)?.status, 'failed');
  assert.equal(getJob(db, stale.id)?.error, 'interrupted by server restart');
});

test('jobs enqueued before start are not run until start', async () => {
  const ran: string[] = [];
  const { runner, db, draftId } = setup(async (job, ctx) => {
    ran.push(job.id);
    return { outputPath: join(ctx.workDir, 'o.mp4') };
  });
  const job = runner.enqueue(draftId);
  await tick();
  assert.deepEqual(ran, []);
  assert.equal(getJob(db, job.id)?.status, 'queued');
});

test('idle resolves immediately when nothing is queued', async () => {
  const { runner } = setup(async () => ({ outputPath: '' }));
  runner.start();
  await runner.idle();
});
