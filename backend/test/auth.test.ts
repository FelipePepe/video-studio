import { test } from 'node:test';
import * as assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { makeTokenAuth } from '../src/config/auth';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';

function tinyApp(token?: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(makeTokenAuth(token));
  app.get('/x', (_req, res) => res.status(200).json({ ok: 1 }));
  app.patch('/x', (_req, res) => res.status(200).json({ ok: 1 }));
  app.post('/x', (_req, res) => res.status(200).json({ ok: 1 }));
  return app;
}

test('token auth: GET (read-only) always passes', async () => {
  const r = await request(tinyApp('secret')).get('/x');
  assert.equal(r.status, 200);
});

test('token auth: mutating 401 without/wrong, 200 with Bearer or x-api-token', async () => {
  const app = tinyApp('secret');
  assert.equal((await request(app).patch('/x')).status, 401, 'no token');
  assert.equal((await request(app).post('/x')).status, 401, 'no token (post)');
  assert.equal((await request(app).patch('/x').set('authorization', 'Bearer wrong')).status, 401, 'wrong token');
  assert.equal((await request(app).patch('/x').set('authorization', 'Bearer secret')).status, 200, 'Bearer ok');
  assert.equal((await request(app).patch('/x').set('x-api-token', 'secret')).status, 200, 'x-api-token ok');
});

test('token auth: unset token is a no-op (all requests pass)', async () => {
  assert.equal((await request(tinyApp(undefined)).patch('/x')).status, 200);
  assert.equal((await request(tinyApp('')).patch('/x')).status, 200);
});

test('buildApp(apiKey) guards mutating config routes, not reads', async () => {
  const app = buildApp({ db: openDatabase(':memory:'), envDefaults: loadEnvDefaults({}), apiKey: 'tok' });
  assert.equal((await request(app).get('/api/config')).status, 200, 'GET is read-only');
  const noTok = await request(app).patch('/api/config').send({ ollamaModel: 'x' });
  assert.equal(noTok.status, 401, 'PATCH without token');
  const ok = await request(app).patch('/api/config').set('authorization', 'Bearer tok').send({ ollamaModel: 'x' });
  assert.notEqual(ok.status, 401, 'PATCH with token is not rejected');
});
