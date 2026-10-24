import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import { markApproved } from '../src/pipeline/draftRepository';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { OllamaTimeoutError, type OllamaClient } from '../src/clients/ollama';

const scenes = [
  { title: 'A', narration: 'na', visualPrompt: 'va' },
  { title: 'B', narration: 'nb', visualPrompt: 'vb' },
];

function fakeOllama(result: unknown | Error): OllamaClient {
  return {
    chatJson: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as OllamaClient;
}

function makeApp(ollama: OllamaClient, fetchImpl?: typeof fetch, draftConcurrency?: number) {
  const db = openDatabase(':memory:');
  return { db, app: buildApp({ db, envDefaults: loadEnvDefaults({}), ollama, fetchImpl, draftConcurrency }) };
}

/** Ollama fake whose calls stay pending until released or until their signal aborts. */
function gatedOllama() {
  const signals: Array<AbortSignal | undefined> = [];
  const releases: Array<() => void> = [];
  const ollama = {
    chatJson: (opts: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        signals.push(opts.signal);
        releases.push(() => resolve({ scenes }));
        opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
  } as unknown as OllamaClient;
  return { ollama, signals, releases };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'condition not met in time');
};

function listen(app: ReturnType<typeof buildApp>) {
  return new Promise<http.Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function postDraft(server: http.Server) {
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify({ text: 'x' });
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/pipeline/draft', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => undefined);
  req.end(body);
  return req;
}

test('POST /api/pipeline/draft creates a draft (201)', async () => {
  const { app } = makeApp(fakeOllama({ scenes }));
  const res = await request(app).post('/api/pipeline/draft').send({ text: 'articulo', mix: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'draft');
  assert.equal(typeof res.body.id, 'string');
  assert.deepEqual(res.body.escaleta.map((s: { voice: string }) => s.voice), ['male', 'female']);
});

test('POST with url fetches the article through the injected fetch', async () => {
  const fetchImpl = (async () =>
    new Response('<p>web</p>', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
  const { app } = makeApp(fakeOllama({ scenes }), fetchImpl);
  const res = await request(app).post('/api/pipeline/draft').send({ url: 'https://example.com/a' });
  assert.equal(res.status, 201);
});

test('POST returns 400 for invalid input', async () => {
  const { app } = makeApp(fakeOllama({ scenes }));
  for (const body of [{}, { url: 'https://e.com', text: 'x' }, { url: 'ftp://e.com' }, { text: 'x', mix: 'yes' }]) {
    const res = await request(app).post('/api/pipeline/draft').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof res.body.error, 'string');
  }
});

test('POST returns 502 when Ollama fails or returns an invalid escaleta', async () => {
  for (const ollama of [fakeOllama(new Error('Ollama unreachable')), fakeOllama({ scenes: [] })]) {
    const { app } = makeApp(ollama);
    const res = await request(app).post('/api/pipeline/draft').send({ text: 'x' });
    assert.equal(res.status, 502);
    assert.equal(typeof res.body.error, 'string');
  }
});

test('POST returns 502 when the article fetch fails', async () => {
  const fetchImpl = (async () => new Response('x', { status: 500 })) as typeof fetch;
  const { app } = makeApp(fakeOllama({ scenes }), fetchImpl);
  const res = await request(app).post('/api/pipeline/draft').send({ url: 'https://example.com' });
  assert.equal(res.status, 502);
});

test('GET /api/pipeline/draft/:id returns the draft or 404', async () => {
  const { app } = makeApp(fakeOllama({ scenes }));
  const created = await request(app).post('/api/pipeline/draft').send({ text: 'x' });
  const res = await request(app).get(`/api/pipeline/draft/${created.body.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
  assert.equal(res.body.sourceKind, 'text');
  assert.equal((await request(app).get('/api/pipeline/draft/missing')).status, 404);
});

test('PUT segments revalidates and saves; keeps edited voices', async () => {
  const { app } = makeApp(fakeOllama({ scenes }));
  const { body: created } = await request(app).post('/api/pipeline/draft').send({ text: 'x' });
  const edited = [
    { scene: 7, title: ' New ', narration: 'n', visualPrompt: 'v', voice: 'female' },
    { scene: 9, title: 'Two', narration: 'n2', visualPrompt: 'v2', voice: 'male' },
  ];
  const res = await request(app).put(`/api/pipeline/draft/${created.id}/segments`).send({ escaleta: edited });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.escaleta.map((s: { scene: number; title: string; voice: string }) => [s.scene, s.title, s.voice]), [
    [1, 'New', 'female'],
    [2, 'Two', 'male'],
  ]);
  const got = await request(app).get(`/api/pipeline/draft/${created.id}`);
  assert.equal(got.body.escaleta[0].title, 'New');
});

test('PUT segments returns 400 for invalid escaleta, 404 for unknown id, 409 when approved', async () => {
  const { app, db } = makeApp(fakeOllama({ scenes }));
  const { body: created } = await request(app).post('/api/pipeline/draft').send({ text: 'x' });
  const url = `/api/pipeline/draft/${created.id}/segments`;
  assert.equal((await request(app).put(url).send({ escaleta: [] })).status, 400);
  assert.equal((await request(app).put(url).send({})).status, 400);
  assert.equal((await request(app).put('/api/pipeline/draft/missing/segments').send({ escaleta: scenes })).status, 404);
  markApproved(db, created.id);
  const locked = await request(app).put(url).send({ escaleta: scenes });
  assert.equal(locked.status, 409);
});

test('POST /draft aborts the Ollama signal when the client disconnects', async () => {
  const g = gatedOllama();
  const { app } = makeApp(g.ollama);
  const server = await listen(app);
  try {
    const req = postDraft(server);
    await until(() => g.signals.length === 1);
    assert.equal(g.signals[0]?.aborted, false);
    req.destroy();
    await until(() => g.signals[0]?.aborted === true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('POST /draft does not abort the signal for a request that completes', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const ollama = { chatJson: async (o: { signal?: AbortSignal }) => (signals.push(o.signal), { scenes }) } as unknown as OllamaClient;
  const { app } = makeApp(ollama);
  const res = await request(app).post('/api/pipeline/draft').send({ text: 'x' });
  assert.equal(res.status, 201);
  assert.equal(signals[0]?.aborted, false);
});

test('POST /draft answers 429 with Retry-After beyond the concurrency limit, then recovers', async () => {
  const g = gatedOllama();
  const { app } = makeApp(g.ollama, undefined, 1);
  const first = request(app).post('/api/pipeline/draft').send({ text: 'x' }).then((r) => r);
  await until(() => g.signals.length === 1);
  const second = await request(app).post('/api/pipeline/draft').send({ text: 'y' });
  assert.equal(second.status, 429);
  assert.equal(second.headers['retry-after'], '10');
  assert.equal(second.body.error, 'Too many drafts in progress, try again shortly');
  assert.equal(g.signals.length, 1, 'Ollama must not be called for the rejected request');
  g.releases[0]();
  assert.equal((await first).status, 201);
  const third = request(app).post('/api/pipeline/draft').send({ text: 'z' }).then((r) => r);
  await until(() => g.signals.length === 2);
  g.releases[1]();
  assert.equal((await third).status, 201);
});

test('DRAFT_MAX_CONCURRENCY sets the limit; empty or invalid values fall back to the default of 2', async () => {
  const saved = process.env.DRAFT_MAX_CONCURRENCY;
  try {
    // "1" -> the second concurrent draft is rejected.
    process.env.DRAFT_MAX_CONCURRENCY = '1';
    const one = gatedOllama();
    const { app: appOne } = makeApp(one.ollama);
    const firstOne = request(appOne).post('/api/pipeline/draft').send({ text: 'x' }).then((r) => r);
    await until(() => one.signals.length === 1);
    assert.equal((await request(appOne).post('/api/pipeline/draft').send({ text: 'y' })).status, 429);
    one.releases[0]();
    assert.equal((await firstOne).status, 201);

    // invalid / empty -> default 2: two are accepted, the third is rejected.
    for (const value of ['abc', '', '0', '-3']) {
      process.env.DRAFT_MAX_CONCURRENCY = value;
      const g = gatedOllama();
      const { app } = makeApp(g.ollama);
      const a = request(app).post('/api/pipeline/draft').send({ text: 'a' }).then((r) => r);
      const b = request(app).post('/api/pipeline/draft').send({ text: 'b' }).then((r) => r);
      await until(() => g.signals.length === 2);
      assert.equal((await request(app).post('/api/pipeline/draft').send({ text: 'c' })).status, 429, `value "${value}"`);
      g.releases[0]();
      g.releases[1]();
      assert.equal((await a).status, 201);
      assert.equal((await b).status, 201);
    }
  } finally {
    if (saved === undefined) delete process.env.DRAFT_MAX_CONCURRENCY;
    else process.env.DRAFT_MAX_CONCURRENCY = saved;
  }
});

test('the draft slot is released after an Ollama error', async () => {
  let n = 0;
  const ollama = {
    chatJson: async () => {
      if (n++ === 0) throw new Error('boom');
      return { scenes };
    },
  } as unknown as OllamaClient;
  const { app } = makeApp(ollama, undefined, 1);
  assert.equal((await request(app).post('/api/pipeline/draft').send({ text: 'x' })).status, 502);
  assert.equal((await request(app).post('/api/pipeline/draft').send({ text: 'x' })).status, 201);
});

test('the draft slot is released after a client abort', async () => {
  const g = gatedOllama();
  const { app } = makeApp(g.ollama, undefined, 1);
  const server = await listen(app);
  try {
    const req = postDraft(server);
    await until(() => g.signals.length === 1);
    req.destroy();
    await until(() => g.signals[0]?.aborted === true);
    await new Promise((r) => setTimeout(r, 20));
    const next = request(app).post('/api/pipeline/draft').send({ text: 'x' }).then((r) => r);
    await until(() => g.signals.length === 2);
    g.releases[1]();
    assert.equal((await next).status, 201);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('POST /draft maps an Ollama timeout to a generic 504', async () => {
  const ollama = {
    chatJson: async () => {
      throw new OllamaTimeoutError('Ollama chat timed out after 300000ms');
    },
  } as unknown as OllamaClient;
  const { app } = makeApp(ollama);
  const res = await request(app).post('/api/pipeline/draft').send({ text: 'x' });
  assert.equal(res.status, 504);
  assert.deepEqual(res.body, { error: 'The language model took too long to respond' });
});

test('GET /draft/:id/publish maps an Ollama timeout to 504', async () => {
  const slow = {
    chatJson: async () => {
      throw new OllamaTimeoutError('Ollama chat timed out after 300000ms');
    },
  } as unknown as OllamaClient;
  const { app: app2, db: db2 } = makeApp(slow);
  const { createDraft } = await import('../src/pipeline/draftRepository');
  const d = createDraft(db2, {
    escaleta: scenes.map((s, i) => ({ scene: i + 1, voice: 'male' as const, ...s })), sourceKind: 'text', sourceRef: 'x', language: 'es',
    voiceA: 'male', voiceB: 'female', mix: false,
  });
  const res = await request(app2).get(`/api/pipeline/draft/${d.id}/publish`);
  assert.equal(res.status, 504);
  assert.deepEqual(res.body, { error: 'The language model took too long to respond' });
});
