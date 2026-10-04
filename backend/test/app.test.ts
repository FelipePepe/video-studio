import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import type { AppResolvers } from '../src/app';

const envDefaults = loadEnvDefaults({});

function makeApp(extra: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({ db: openDatabase(':memory:'), envDefaults, ...extra });
}

test('GET /api/config returns env defaults when DB is empty', async () => {
  const res = await request(makeApp()).get('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, envDefaults);
});

test('PATCH /api/config overrides a single host and GET reflects it', async () => {
  const app = makeApp();
  const patch = await request(app).patch('/api/config').send({ comfyHost: 'http://c:1' });
  assert.equal(patch.status, 200);
  assert.deepEqual(patch.body, { ...envDefaults, comfyHost: 'http://c:1' });
  const get = await request(app).get('/api/config');
  assert.deepEqual(get.body, { ...envDefaults, comfyHost: 'http://c:1' });
});

test('PATCH /api/config with empty string falls back to env default', async () => {
  const app = makeApp();
  await request(app).patch('/api/config').send({ ollamaHost: 'http://o:2' });
  const res = await request(app).patch('/api/config').send({ ollamaHost: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ollamaHost, envDefaults.ollamaHost);
});

for (const bad of ['ftp://x', 'not a url', 42]) {
  test(`PATCH /api/config rejects invalid value ${JSON.stringify(bad)}`, async () => {
    const app = makeApp();
    const res = await request(app).patch('/api/config').send({ kokoroHost: bad });
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
    const get = await request(app).get('/api/config');
    assert.deepEqual(get.body, envDefaults);
  });
}

test('PATCH /api/config rejects a non-object body', async () => {
  const res = await request(makeApp()).patch('/api/config').send([1]);
  assert.equal(res.status, 400);
});

test('PATCH takes effect on resolvers without restart', async () => {
  const app = makeApp();
  const r = app.locals as AppResolvers;
  assert.equal(r.resolveComfy().host, envDefaults.comfyHost);
  await request(app).patch('/api/config').send({ comfyHost: 'http://new:9' });
  assert.equal(r.resolveComfy().host, 'http://new:9');
  assert.equal(r.resolveOllama().host, envDefaults.ollamaHost);
  assert.equal(r.resolveKokoro().host, envDefaults.kokoroHost);
});

test('static client passed to buildApp wins over DB config', async () => {
  const comfy = { host: 'http://static:1' };
  const app = makeApp({ comfy });
  await request(app).patch('/api/config').send({ comfyHost: 'http://db:2' });
  const r = app.locals as AppResolvers;
  assert.equal(r.resolveComfy(), comfy);
});
