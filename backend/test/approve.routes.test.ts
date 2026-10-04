import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import { wavFromPcm } from '../src/media/wav';
import type { ComfyClient } from '../src/clients/comfy';
import type { OllamaClient } from '../src/clients/ollama';
import type { PiperClient } from '../src/clients/piper';
import type { JobRunner } from '../src/jobs/runner';
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

const fakeOllama = {
  chatJson: async () => ({
    scenes: [
      { title: 'A', narration: 'na', visualPrompt: 'va' },
      { title: 'B', narration: 'nb', visualPrompt: 'vb' },
    ],
  }),
} as unknown as OllamaClient;

const fakeComfy = {
  submit: async () => 'p1',
  waitForCompletion: async () => ({ '9': { gifs: [{ filename: 'o.mp4' }] } }),
  download: async () => Buffer.from('video'),
  uploadImage: async (_d: Buffer, name: string) => name,
  interrupt: async () => {},
} as unknown as ComfyClient;

const fakePiper = {
  synthesize: async () => wavFromPcm(Buffer.alloc(8000), { rate: 16000, width: 2, channels: 1 }),
} as unknown as PiperClient;

function setup(execute?: ExecuteFn) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-approve-'));
  dirs.push(workDir);
  const app = buildApp({
    db: openDatabase(':memory:'),
    envDefaults: loadEnvDefaults({}),
    ollama: fakeOllama,
    comfy: fakeComfy,
    piper: fakePiper,
    ffmpeg: async (args) => writeFileSync(args[args.length - 1], 'fake-mp4-bytes'),
    jobs: { workDir, autoStart: true, execute },
  });
  const runner = app.locals.jobRunner as JobRunner;
  return { app, runner };
}

async function createDraftId(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await request(app).post('/api/pipeline/draft').send({ text: 'article' });
  assert.equal(res.status, 201);
  return res.body.id as string;
}

async function listen(app: ReturnType<typeof buildApp>): Promise<number> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

function post(port: number, path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ res: http.IncomingMessage; text: () => string; closed: Promise<void>; abort: () => void }>(
    (resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (buf += c));
        const closed = new Promise<void>((r) => {
          res.on('end', r);
          res.on('close', r);
        });
        resolve({ res, text: () => buf, closed, abort: () => req.destroy() });
      });
      req.on('error', reject);
      req.end();
    },
  );
}

const dataEvents = (text: string): JobEvent[] =>
  text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as JobEvent);

test('approve streams SSE from queued to done and the output is downloadable', async () => {
  const { app } = setup();
  const draftId = await createDraftId(app);
  const port = await listen(app);
  const s = await post(port, `/api/pipeline/draft/${draftId}/approve`);
  assert.equal(s.res.statusCode, 200);
  assert.match(String(s.res.headers['content-type']), /text\/event-stream/);
  await s.closed;
  const events = dataEvents(s.text());
  assert.equal(events[0].type, 'stage');
  assert.equal(events[0].stage, 'queued');
  const jobId = events[0].jobId;
  assert.ok(jobId);
  assert.deepEqual(
    [...new Set(events.filter((e) => e.type === 'stage').map((e) => e.stage))],
    ['queued', 'tts', 'images', 'transitions', 'assemble'],
  );
  assert.ok(events.every((e) => e.jobId === jobId));
  const last = events[events.length - 1];
  assert.equal(last.type, 'done');
  assert.equal(last.outputUrl, `/api/jobs/${jobId}/output`);

  const job = await request(app).get(`/api/jobs/${jobId}`);
  assert.equal(job.body.status, 'done');
  assert.equal(job.body.draftId, draftId);
  const out = await request(app).get(`/api/jobs/${jobId}/output`).buffer(true);
  assert.equal(out.status, 200);
  assert.equal(out.body.toString(), 'fake-mp4-bytes');
  assert.equal((await request(app).get(`/api/pipeline/draft/${draftId}`)).body.status, 'approved');
});

test('approve returns 404 for an unknown draft and 409 when already approved', async () => {
  const { app } = setup();
  assert.equal((await request(app).post('/api/pipeline/draft/nope/approve')).status, 404);
  const draftId = await createDraftId(app);
  const first = await request(app).post(`/api/pipeline/draft/${draftId}/approve`).set('Accept', 'application/json');
  assert.equal(first.status, 202);
  const second = await request(app).post(`/api/pipeline/draft/${draftId}/approve`);
  assert.equal(second.status, 409);
});

test('Accept: application/json returns 202 with the job id and the job completes', async () => {
  const { app, runner } = setup();
  const draftId = await createDraftId(app);
  const res = await request(app).post(`/api/pipeline/draft/${draftId}/approve`).set('Accept', 'application/json');
  assert.equal(res.status, 202);
  assert.equal(typeof res.body.jobId, 'string');
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${res.body.jobId}`)).body.status, 'done');
});

test('a client disconnect does not cancel the job and it can be followed via /events', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const execute: ExecuteFn = async (_job, ctx) => {
    ctx.emit({ type: 'stage', stage: 'tts', progress: 0.1 });
    await gate;
    const outputPath = join(ctx.workDir, 'final.mp4');
    writeFileSync(outputPath, 'late');
    return { outputPath };
  };
  const { app, runner } = setup(execute);
  const draftId = await createDraftId(app);
  const port = await listen(app);
  const s = await post(port, `/api/pipeline/draft/${draftId}/approve`);
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (s.text().includes('"tts"')) {
        clearInterval(t);
        resolve();
      }
    }, 5);
  });
  const jobId = dataEvents(s.text())[0].jobId;
  s.abort();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await request(app).get(`/api/jobs/${jobId}`)).body.status, 'running');
  release();
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${jobId}`)).body.status, 'done');
});

function gatedExecute() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const execute: ExecuteFn = async (_job, ctx) => {
    await gate;
    const outputPath = join(ctx.workDir, 'final.mp4');
    writeFileSync(outputPath, 'x');
    return { outputPath };
  };
  return { execute, release };
}

const approveJson = (app: ReturnType<typeof buildApp>, id: string) =>
  request(app).post(`/api/pipeline/draft/${id}/approve`).set('Accept', 'application/json');

test('a job creation failure rolls the draft back to draft', async () => {
  const { app, runner } = setup();
  const draftId = await createDraftId(app);
  const original = runner.createJob;
  runner.createJob = () => {
    throw new Error('disk full');
  };
  const failed = await approveJson(app, draftId);
  assert.equal(failed.status, 500);
  assert.equal((await request(app).get(`/api/pipeline/draft/${draftId}`)).body.status, 'draft');
  runner.createJob = original;
  const retry = await approveJson(app, draftId);
  assert.equal(retry.status, 202);
  await runner.idle();
});

test('approve after a failed job creates a new job', async () => {
  let calls = 0;
  const execute: ExecuteFn = async (_job, ctx) => {
    if (calls++ === 0) throw new Error('boom');
    const outputPath = join(ctx.workDir, 'final.mp4');
    writeFileSync(outputPath, 'x');
    return { outputPath };
  };
  const { app, runner } = setup(execute);
  const draftId = await createDraftId(app);
  const first = await approveJson(app, draftId);
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${first.body.jobId}`)).body.status, 'failed');
  const second = await approveJson(app, draftId);
  assert.equal(second.status, 202);
  assert.notEqual(second.body.jobId, first.body.jobId);
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${second.body.jobId}`)).body.status, 'done');
  assert.equal((await request(app).get(`/api/pipeline/draft/${draftId}`)).body.status, 'approved');
});

test('approve after a cancelled job creates a new job', async () => {
  const { execute, release } = gatedExecute();
  const { app, runner } = setup(execute);
  const draftId = await createDraftId(app);
  const first = await approveJson(app, draftId);
  assert.equal(await runner.cancel(first.body.jobId), true);
  release();
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${first.body.jobId}`)).body.status, 'cancelled');
  const second = await approveJson(app, draftId);
  assert.equal(second.status, 202);
  assert.notEqual(second.body.jobId, first.body.jobId);
  await runner.idle();
});

test('approve stays 409 while the latest job is queued, running or done', async () => {
  const { execute, release } = gatedExecute();
  const { app, runner } = setup(execute);
  const running = await createDraftId(app);
  const queued = await createDraftId(app);
  const first = await approveJson(app, running);
  assert.equal((await request(app).get(`/api/jobs/${first.body.jobId}`)).body.status, 'running');
  const second = await approveJson(app, queued);
  assert.equal((await request(app).get(`/api/jobs/${second.body.jobId}`)).body.status, 'queued');
  assert.equal((await approveJson(app, running)).status, 409);
  assert.equal((await approveJson(app, queued)).status, 409);
  release();
  await runner.idle();
  assert.equal((await request(app).get(`/api/jobs/${first.body.jobId}`)).body.status, 'done');
  assert.equal((await approveJson(app, running)).status, 409);
});
