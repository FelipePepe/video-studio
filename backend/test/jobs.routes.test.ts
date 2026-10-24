import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import { createDraft } from '../src/pipeline/draftRepository';
import { createJob, markDone, markFailed, markRunning, updateJob } from '../src/jobs/jobRepository';
import type { EventHub } from '../src/jobs/eventHub';
import { unconfiguredExecute, type JobRunner } from '../src/jobs/runner';
import type { ExecuteFn, JobEvent } from '../src/jobs/types';

const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { execute?: ExecuteFn; heartbeatMs?: number } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-jobs-routes-'));
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
  const app = buildApp({
    db,
    envDefaults: loadEnvDefaults({}),
    jobs: { workDir, execute: opts.execute, heartbeatMs: opts.heartbeatMs },
  });
  const hub = app.locals.eventHub as EventHub;
  const runner = app.locals.jobRunner as JobRunner;
  return { app, db, hub, runner, workDir, draftId: draft.id };
}

async function listen(app: ReturnType<typeof buildApp>): Promise<number> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

interface Stream {
  res: http.IncomingMessage;
  text: () => string;
  closed: Promise<void>;
  until: (pred: (text: string) => boolean) => Promise<void>;
  destroy: () => void;
}

function openStream(port: number, path: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let buf = '';
      const waiters: Array<{ pred: (t: string) => boolean; done: () => void }> = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        for (const w of waiters.filter((x) => x.pred(buf))) w.done();
      });
      const closed = new Promise<void>((r) => {
        res.on('end', r);
        res.on('close', r);
      });
      resolve({
        res,
        text: () => buf,
        closed,
        until: (pred) => (pred(buf) ? Promise.resolve() : new Promise((done) => waiters.push({ pred, done }))),
        destroy: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

const dataEvents = (text: string): JobEvent[] =>
  text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as JobEvent);

test('GET /api/jobs lists newest first with status and limit filters', async () => {
  const { app, db, draftId } = setup();
  const a = createJob(db, draftId);
  const b = createJob(db, draftId);
  markRunning(db, a.id);
  const all = await request(app).get('/api/jobs');
  assert.equal(all.status, 200);
  assert.equal(all.body.length, 2);
  assert.deepEqual((await request(app).get('/api/jobs?status=running')).body.map((j: { id: string }) => j.id), [a.id]);
  assert.equal((await request(app).get('/api/jobs?limit=1')).body.length, 1);
  assert.equal((await request(app).get('/api/jobs?status=bogus')).status, 400);
  assert.equal((await request(app).get('/api/jobs?limit=abc')).status, 400);
  assert.ok(b.id);
});

test('GET /api/jobs/:id returns the job or 404', async () => {
  const { app, db, draftId } = setup();
  const job = createJob(db, draftId);
  const res = await request(app).get(`/api/jobs/${job.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, job.id);
  assert.equal(res.body.status, 'queued');
  assert.equal((await request(app).get('/api/jobs/nope')).status, 404);
});

test('POST /api/jobs/:id/cancel cancels a queued job, 404 unknown, 409 finished', async () => {
  const { app, db, draftId } = setup();
  const queued = createJob(db, draftId);
  const res = await request(app).post(`/api/jobs/${queued.id}/cancel`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { cancelled: true });
  assert.equal((await request(app).get(`/api/jobs/${queued.id}`)).body.status, 'cancelled');
  assert.equal((await request(app).post(`/api/jobs/${queued.id}/cancel`)).status, 409);
  assert.equal((await request(app).post('/api/jobs/nope/cancel')).status, 404);
});

test('DELETE /api/jobs/:id deletes a terminal job + workdir, 404 unknown, 409 active', async () => {
  const { app, db, draftId, workDir } = setup();

  const done = createJob(db, draftId);
  mkdirSync(join(workDir, done.id));
  writeFileSync(join(workDir, done.id, 'final.mp4'), Buffer.from('x'));
  markDone(db, done.id, join(workDir, done.id, 'final.mp4'));

  const running = createJob(db, draftId);
  markRunning(db, running.id);

  // done + on disk: 200, row gone, workdir removed
  let res = await request(app).delete(`/api/jobs/${done.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
  assert.equal((await request(app).get(`/api/jobs/${done.id}`)).status, 404);
  assert.equal(existsSync(join(workDir, done.id)), false, 'workdir removed');

  // running: 409 (active)
  res = await request(app).delete(`/api/jobs/${running.id}`);
  assert.equal(res.status, 409);
  assert.equal((await request(app).get(`/api/jobs/${running.id}`)).status, 200);

  // unknown: 404
  res = await request(app).delete('/api/jobs/nope');
  assert.equal(res.status, 404);
});

test('GET /api/jobs/:id/output serves the mp4 bytes with Range support', async () => {
  const { app, db, draftId, workDir } = setup();
  const job = createJob(db, draftId);
  const bytes = Buffer.from('0123456789');
  mkdirSync(join(workDir, job.id));
  writeFileSync(join(workDir, job.id, 'final.mp4'), bytes);
  markDone(db, job.id, join(workDir, job.id, 'final.mp4'));
  const res = await request(app).get(`/api/jobs/${job.id}/output`).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /video\/mp4/);
  assert.deepEqual(res.body, bytes);
  const part = await request(app).get(`/api/jobs/${job.id}/output`).set('Range', 'bytes=2-4');
  assert.equal(part.status, 206);
});

test('GET /api/jobs/:id/output returns 404 when not done, unknown or file missing', async () => {
  const { app, db, draftId, workDir } = setup();
  const queued = createJob(db, draftId);
  assert.equal((await request(app).get(`/api/jobs/${queued.id}/output`)).status, 404);
  assert.equal((await request(app).get('/api/jobs/nope/output')).status, 404);
  const gone = createJob(db, draftId);
  markDone(db, gone.id, join(workDir, gone.id, 'missing.mp4'));
  assert.equal((await request(app).get(`/api/jobs/${gone.id}/output`)).status, 404);
});

test('GET /api/jobs/:id/output rejects paths outside the work dir', async () => {
  const { app, db, draftId, workDir } = setup();
  const outside = mkdtempSync(join(tmpdir(), 'vs-outside-'));
  dirs.push(outside);
  writeFileSync(join(outside, 'secret.mp4'), 'secret');
  for (const path of [join(outside, 'secret.mp4'), join(workDir, '..', 'x', '..', outside.split('/').pop() as string, 'secret.mp4')]) {
    const job = createJob(db, draftId);
    markDone(db, job.id, path);
    const res = await request(app).get(`/api/jobs/${job.id}/output`);
    assert.equal(res.status, 403, path);
    assert.ok(!String(res.text).includes('secret'));
  }
});

test('SSE replays buffered events then delivers live ones and ends after the terminal event', async () => {
  const { app, db, hub, draftId } = setup();
  const port = await listen(app);
  const job = createJob(db, draftId);
  hub.publish({ type: 'stage', jobId: job.id, stage: 'tts', at: 't1' });
  hub.publish({ type: 'progress', jobId: job.id, progress: 0.3, at: 't2' });
  const stream = await openStream(port, `/api/jobs/${job.id}/events`);
  assert.equal(stream.res.statusCode, 200);
  assert.match(String(stream.res.headers['content-type']), /text\/event-stream/);
  assert.equal(stream.res.headers['cache-control'], 'no-cache');
  assert.equal(stream.res.headers['x-accel-buffering'], 'no');
  await stream.until((t) => dataEvents(t).length >= 2);
  assert.deepEqual(dataEvents(stream.text()).map((e) => e.type), ['stage', 'progress']);
  hub.publish({ type: 'progress', jobId: job.id, progress: 0.6, at: 't3' });
  await stream.until((t) => dataEvents(t).length >= 3);
  assert.equal(dataEvents(stream.text())[2].progress, 0.6);
  hub.publish({ type: 'done', jobId: job.id, outputUrl: `/api/jobs/${job.id}/output`, at: 't4' });
  await stream.closed;
  assert.equal(dataEvents(stream.text()).at(-1)?.type, 'done');
  assert.equal(hub.listenerCount(job.id), 0);
});

test('SSE sends a snapshot of the DB state when the buffer is empty', async () => {
  const { app, db, draftId } = setup();
  const port = await listen(app);
  const job = createJob(db, draftId);
  markRunning(db, job.id);
  updateJob(db, job.id, { stage: 'video', progress: 0.5 });
  const stream = await openStream(port, `/api/jobs/${job.id}/events`);
  await stream.until((t) => dataEvents(t).length >= 1);
  const [snap] = dataEvents(stream.text());
  assert.equal(snap.jobId, job.id);
  assert.equal(snap.stage, 'video');
  assert.equal(snap.progress, 0.5);
  stream.destroy();
});

test('SSE snapshot of a finished job carries the terminal event and closes', async () => {
  const { app, db, draftId } = setup();
  const port = await listen(app);
  const ok = createJob(db, draftId);
  markDone(db, ok.id, '/x/o.mp4');
  const s1 = await openStream(port, `/api/jobs/${ok.id}/events`);
  await s1.closed;
  const done = dataEvents(s1.text()).at(-1);
  assert.equal(done?.type, 'done');
  assert.equal(done?.outputUrl, `/api/jobs/${ok.id}/output`);
  const bad = createJob(db, draftId);
  markFailed(db, bad.id, 'boom');
  const s2 = await openStream(port, `/api/jobs/${bad.id}/events`);
  await s2.closed;
  assert.equal(dataEvents(s2.text()).at(-1)?.type, 'error');
  assert.equal(dataEvents(s2.text()).at(-1)?.message, 'boom');
});

test('SSE returns 404 for an unknown job', async () => {
  const { app } = setup();
  const port = await listen(app);
  const stream = await openStream(port, '/api/jobs/nope/events');
  assert.equal(stream.res.statusCode, 404);
  stream.destroy();
});

test('SSE sends heartbeat pings at the injected interval', async () => {
  const { app, db, draftId } = setup({ heartbeatMs: 20 });
  const port = await listen(app);
  const job = createJob(db, draftId);
  const stream = await openStream(port, `/api/jobs/${job.id}/events`);
  await stream.until((t) => (t.match(/: ping\n\n/g) ?? []).length >= 2);
  stream.destroy();
});

test('SSE unsubscribes when the client disconnects and the job keeps running', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const { app, db, hub, runner, draftId } = setup({
    execute: async (_job, ctx) => {
      ctx.emit({ type: 'stage', stage: 'work' });
      await gate;
      return { outputPath: join(ctx.workDir, 'o.mp4') };
    },
  });
  runner.start();
  const port = await listen(app);
  const job = runner.enqueue(draftId);
  const stream = await openStream(port, `/api/jobs/${job.id}/events`);
  await stream.until((t) => dataEvents(t).length >= 1);
  assert.equal(hub.listenerCount(job.id), 1);
  stream.destroy();
  for (let i = 0; i < 50 && hub.listenerCount(job.id) > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(hub.listenerCount(job.id), 0);
  finish();
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${job.id}`)).body.status, 'done');
});

test('cancelling a running job over HTTP ends with a cancelled event on the stream', async () => {
  const { app, runner, draftId } = setup({
    execute: (_job, ctx) =>
      new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted')))),
  });
  runner.start();
  const port = await listen(app);
  const job = runner.enqueue(draftId);
  const stream = await openStream(port, `/api/jobs/${job.id}/events`);
  await stream.until((t) => t.length > 0);
  const res = await request(app).post(`/api/jobs/${job.id}/cancel`);
  assert.equal(res.status, 200);
  await stream.closed;
  assert.equal(dataEvents(stream.text()).at(-1)?.type, 'cancelled');
});

test('buildApp defaults to the orchestrator, which rejects a draft without scenes', async () => {
  const { runner, db, draftId } = setup();
  runner.start();
  const job = runner.enqueue(draftId);
  await runner.idle();
  const row = db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(job.id) as { status: string; error: string };
  assert.equal(row.status, 'failed');
  assert.match(row.error, /has no scenes/);
});

test('unconfiguredExecute can still be injected explicitly', async () => {
  const { runner, db, draftId } = setup({ execute: unconfiguredExecute });
  runner.start();
  const job = runner.enqueue(draftId);
  await runner.idle();
  const row = db.prepare('SELECT error FROM jobs WHERE id = ?').get(job.id) as { error: string };
  assert.equal(row.error, 'pipeline not configured');
});
