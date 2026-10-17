import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import { markApproved } from '../src/pipeline/draftRepository';
import type { OllamaClient } from '../src/clients/ollama';

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

function makeApp(ollama: OllamaClient, fetchImpl?: typeof fetch) {
  const db = openDatabase(':memory:');
  return { db, app: buildApp({ db, envDefaults: loadEnvDefaults({}), ollama, fetchImpl }) };
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
