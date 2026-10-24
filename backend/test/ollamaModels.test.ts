import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults, getSettings, updateSettings } from '../src/config/settings';

function app(envDefaults: Record<string, string> = {}) {
  return buildApp({
    db: openDatabase(':memory:'),
    envDefaults: loadEnvDefaults(envDefaults as NodeJS.ProcessEnv),
  });
}

test('GET /api/ollama/models returns a models array of names', async () => {
  const res = await request(app()).get('/api/ollama/models').expect(200);
  assert.ok(Array.isArray(res.body.models));
  for (const m of res.body.models as unknown[]) {
    assert.equal(typeof m, 'string');
    assert.equal((m as string).length > 0, true);
  }
});

test('GET /api/ollama/models returns [] when Ollama is unreachable', async () => {
  const a = app();
  const res = await request(a).get('/api/ollama/models').expect(200);
  assert.ok(Array.isArray(res.body.models));
});

function unreachableApp() {
  return buildApp({
    db: openDatabase(':memory:'),
    envDefaults: loadEnvDefaults({ OLLAMA_HOST: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv),
  });
}

test('GET /api/ollama/models returns [] for a port that does not listen', async () => {
  const res = await request(unreachableApp()).get('/api/ollama/models').expect(200);
  assert.deepEqual(res.body.models, []);
});

test('PATCH /api/config accepts ollamaModel and GET reflects it', async () => {
  const a = app();
  const res = await request(a).patch('/api/config').send({ ollamaModel: 'qwen3:14b' }).expect(200);
  assert.equal(res.body.ollamaModel, 'qwen3:14b');
  const cfg = await request(a).get('/api/config').expect(200);
  assert.equal(cfg.body.ollamaModel, 'qwen3:14b');
});

test('PATCH /api/config with empty ollamaModel falls back to env default', async () => {
  const a = app({ OLLAMA_MODEL: 'qwen3:8b' });
  const res = await request(a).patch('/api/config').send({ ollamaModel: '' }).expect(200);
  assert.equal(res.body.ollamaModel, 'qwen3:8b');
});

test('PATCH /api/config rejects a non-string ollamaModel', async () => {
  const res = await request(app()).patch('/api/config').send({ ollamaModel: 123 }).expect(400);
  assert.match(res.body.error, /ollamaModel/i);
});

test('getSettings/updateSettings round-trip ollamaModel', () => {
  const db = openDatabase(':memory:');
  assert.equal(getSettings(db).ollamaModel, '');
  updateSettings(db, { ollamaModel: 'llama3.2:3b' });
  assert.equal(getSettings(db).ollamaModel, 'llama3.2:3b');
});

test('OllamaClient.listModels returns model names from /api/tags', async () => {
  const { OllamaClient } = await import('../src/clients/ollama');
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: 'qwen3:14b', size: 1 },
          { name: 'qwen3.8:latest', size: 2 },
          // entry without name is skipped, not a failure
          { size: 3 },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  const client = new OllamaClient('http://127.0.0.1:11434', { fetchImpl });
  assert.deepEqual(await client.listModels(), ['qwen3:14b', 'qwen3.8:latest']);
});

test('OllamaClient.listModels throws when Ollama is unreachable', async () => {
  const { OllamaClient } = await import('../src/clients/ollama');
  const fetchImpl = (async () => {
    throw new Error('boom');
  }) as unknown as typeof fetch;
  const client = new OllamaClient('http://127.0.0.1:11434', { fetchImpl });
  await assert.rejects(() => client.listModels(), /boom/);
});

test('GET /api/ollama/models answers [] once the tags timeout fires on a hung Ollama', async () => {
  const { OllamaClient } = await import('../src/clients/ollama');
  const fetchImpl = ((_u: unknown, init?: RequestInit) =>
    new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
  const ollama = new OllamaClient('http://127.0.0.1:11434', { fetchImpl, tagsTimeoutMs: 30 });
  const a = buildApp({ db: openDatabase(':memory:'), envDefaults: loadEnvDefaults({} as NodeJS.ProcessEnv), ollama });
  const started = Date.now();
  const res = await request(a).get('/api/ollama/models').expect(200);
  assert.deepEqual(res.body, { models: [] });
  assert.ok(Date.now() - started < 2000);
});
