import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection';
import { createDraft } from '../src/pipeline/draftRepository';
import {
  createJob,
  failInterruptedJobs,
  getJob,
  listJobs,
  markCancelled,
  markDone,
  markFailed,
  markRunning,
  updateJob,
} from '../src/jobs/jobRepository';

function setup() {
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
  let n = 0;
  const ids = () => `job-${++n}`;
  let t = Date.UTC(2026, 0, 1);
  const clock = () => new Date((t += 1000));
  return { db, draftId: draft.id, ids, clock };
}

test('createJob inserts a queued job with defaults', () => {
  const { db, draftId, ids, clock } = setup();
  const job = createJob(db, draftId, clock, ids);
  assert.equal(job.id, 'job-1');
  assert.equal(job.draftId, draftId);
  assert.equal(job.status, 'queued');
  assert.equal(job.stage, '');
  assert.equal(job.progress, 0);
  assert.equal(job.error, null);
  assert.equal(job.outputPath, null);
  assert.equal(job.startedAt, null);
  assert.equal(job.finishedAt, null);
  assert.equal(job.createdAt, job.updatedAt);
  assert.deepEqual(getJob(db, 'job-1'), job);
});

test('createJob rejects an unknown draft (foreign key)', () => {
  const { db } = setup();
  assert.throws(() => createJob(db, 'missing'));
});

test('getJob returns undefined for an unknown id', () => {
  assert.equal(getJob(setup().db, 'nope'), undefined);
});

test('listJobs returns newest first, honours limit and status filter', () => {
  const { db, draftId, ids, clock } = setup();
  for (let i = 0; i < 4; i++) createJob(db, draftId, clock, ids);
  markRunning(db, 'job-2', clock);
  assert.deepEqual(listJobs(db).map((j) => j.id), ['job-4', 'job-3', 'job-2', 'job-1']);
  assert.deepEqual(listJobs(db, { limit: 2 }).map((j) => j.id), ['job-4', 'job-3']);
  assert.deepEqual(listJobs(db, { status: 'running' }).map((j) => j.id), ['job-2']);
  assert.equal(listJobs(db, { status: 'done' }).length, 0);
});

test('updateJob patches stage and progress and bumps updatedAt', () => {
  const { db, draftId, ids, clock } = setup();
  const job = createJob(db, draftId, clock, ids);
  const updated = updateJob(db, job.id, { stage: 'tts', progress: 0.5 }, clock);
  assert.equal(updated?.stage, 'tts');
  assert.equal(updated?.progress, 0.5);
  assert.notEqual(updated?.updatedAt, job.updatedAt);
  assert.equal(updateJob(db, 'missing', { stage: 'x' }), undefined);
});

test('markRunning, markDone, markFailed, markCancelled set status and timestamps', () => {
  const { db, draftId, ids, clock } = setup();
  for (let i = 0; i < 3; i++) createJob(db, draftId, clock, ids);
  const running = markRunning(db, 'job-1', clock);
  assert.equal(running?.status, 'running');
  assert.ok(running?.startedAt);
  const done = markDone(db, 'job-1', '/w/out.mp4', clock);
  assert.equal(done?.status, 'done');
  assert.equal(done?.outputPath, '/w/out.mp4');
  assert.equal(done?.progress, 1);
  assert.ok(done?.finishedAt);
  const failed = markFailed(db, 'job-2', 'boom', clock);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, 'boom');
  assert.ok(failed?.finishedAt);
  const cancelled = markCancelled(db, 'job-3', clock);
  assert.equal(cancelled?.status, 'cancelled');
  assert.ok(cancelled?.finishedAt);
});

test('failInterruptedJobs fails running and queued jobs and returns the count', () => {
  const { db, draftId, ids, clock } = setup();
  for (let i = 0; i < 4; i++) createJob(db, draftId, clock, ids);
  markRunning(db, 'job-1', clock);
  markDone(db, 'job-3', '/w/o.mp4', clock);
  markCancelled(db, 'job-4', clock);
  assert.equal(failInterruptedJobs(db, clock), 2);
  for (const id of ['job-1', 'job-2']) {
    assert.equal(getJob(db, id)?.status, 'failed');
    assert.equal(getJob(db, id)?.error, 'interrupted by server restart');
    assert.ok(getJob(db, id)?.finishedAt);
  }
  assert.equal(getJob(db, 'job-3')?.status, 'done');
  assert.equal(getJob(db, 'job-4')?.status, 'cancelled');
  assert.equal(failInterruptedJobs(db, clock), 0);
});
