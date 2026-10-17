import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import type { AppResolvers } from '../src/app';
import { ComfyClient } from '../src/clients/comfy';

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

for (const bad of ['ftp://x', 'not a url', 42, 'http://p:1', 'tcp://nohostport', 'tcp://h:0', 'tcp://h:70000']) {
  test(`PATCH /api/config rejects invalid value ${JSON.stringify(bad)}`, async () => {
    const app = makeApp();
    const res = await request(app).patch('/api/config').send({ piperHost: bad });
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
  assert.equal(r.resolvePiper().host, envDefaults.piperHost);
});

test('static client passed to buildApp wins over DB config', async () => {
  const comfy = new ComfyClient('http://static:1');
  const app = makeApp({ comfy });
  await request(app).patch('/api/config').send({ comfyHost: 'http://db:2' });
  const r = app.locals as AppResolvers;
  assert.equal(r.resolveComfy(), comfy);
});

test('PATCH /api/config rejects an empty object with 400 naming accepted keys', async () => {
  const res = await request(makeApp()).patch('/api/config').send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /comfyHost.*ollamaHost.*piperHost/);
});

test('PATCH /api/config rejects unrecognized keys only', async () => {
  const res = await request(makeApp()).patch('/api/config').send({ foo: 'http://x' });
  assert.equal(res.status, 400);
});

test('PATCH /api/config rejects a request without a body', async () => {
  const res = await request(makeApp()).patch('/api/config');
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test('PATCH /api/config rejects a non-JSON content type', async () => {
  const res = await request(makeApp())
    .patch('/api/config')
    .set('Content-Type', 'text/plain')
    .send('comfyHost=http://x');
  assert.equal(res.status, 400);
});

test('malformed JSON body answers 400 JSON error', async () => {
  const res = await request(makeApp())
    .patch('/api/config')
    .set('Content-Type', 'application/json')
    .send('{"comfyHost":');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Invalid JSON body' });
});

test('unexpected errors answer 500 without leaking internals', async () => {
  const db = openDatabase(':memory:');
  const app = makeApp({ db });
  db.close();
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});

test('PATCH /api/config accepts a tcp piperHost and rejects tcp for comfyHost', async () => {
  const app = makeApp();
  const ok = await request(app).patch('/api/config').send({ piperHost: 'tcp://p:10200' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.piperHost, 'tcp://p:10200');
  const bad = await request(app).patch('/api/config').send({ comfyHost: 'tcp://p:10200' });
  assert.equal(bad.status, 400);
});

test('resolvers build real clients from effective hosts', () => {
  const r = makeApp().locals as AppResolvers;
  assert.ok(r.resolveComfy() instanceof ComfyClient);
  assert.equal(r.resolvePiper().host, envDefaults.piperHost);
});
