import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import request from 'supertest';
import { PiperClient, type PiperVoice } from '../src/clients/piper';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';

const roster: PiperVoice[] = [
  { name: 'es_ES-davefx-medium' },
  { name: 'es_ES-sharvard-medium', speaker: 1 },
  { name: 'en_US-lessac-medium', speaker: 2 },
];

const servers: net.Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function wyomingServer(reply: (sock: net.Socket) => void): Promise<{ host: string }> {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      reply(sock);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return { host: `tcp://127.0.0.1:${port}` };
}

test('PiperClient.listVoices lists voices from the Wyoming describe event', async () => {
  const { host } = await wyomingServer((sock) => {
    sock.write(
      JSON.stringify({
        type: 'describe',
        data: { lang: 'es', voices: roster, format: { rate: 16000, width: 2, channels: 1 } },
      }) + '\n',
    );
  });
  const voices = await new PiperClient(host).listVoices();
  assert.deepEqual(voices, roster);
});

test('PiperClient.listVoices rejects on a Piper error event', async () => {
  const { host } = await wyomingServer((sock) => {
    sock.write(JSON.stringify({ type: 'error', data: { text: 'boom' } }) + '\n');
  });
  await assert.rejects(new PiperClient(host).listVoices(), /Piper error: boom/i);
});

function voiceApp(listVoices: () => Promise<PiperVoice[]>) {
  return buildApp({
    db: openDatabase(':memory:'),
    envDefaults: loadEnvDefaults({}),
    jobs: { workDir: '/tmp/vs-voices', execute: async (job) => ({ outputPath: `/tmp/${job.id}.mp4` }) },
    piper: { listVoices } as never,
  });
}

test('GET /api/pipeline/voices proxies the Piper roster (filtered by ?lang=)', async () => {
  const app = voiceApp(async () => roster);
  const all = await request(app).get('/api/pipeline/voices');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, roster);

  const es = await request(app).get('/api/pipeline/voices?lang=es');
  assert.equal(es.status, 200);
  assert.equal(es.body.length, 2);
  assert.ok(es.body.every((v: { name: string }) => v.name.startsWith('es_ES-')));

  const bogus = await request(app).get('/api/pipeline/voices?lang=12345');
  assert.equal(bogus.status, 400);
  assert.equal((await request(app).get(`/api/pipeline/voices?lang=abc-def-ghi`)).status, 400);
});

test('GET /api/pipeline/voices returns 503 when Piper is unreachable', async () => {
  const app = voiceApp(async () => { throw new Error('Piper unreachable'); });
  const res = await request(app).get('/api/pipeline/voices');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /unreachable/i);
});
