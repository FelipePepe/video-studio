import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { ComfyUnavailableError } from '../src/clients/comfy';
import type { CharacterGenerator, CharacterGenInput } from '../src/characters/characterGenerator';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function crc32Table(): number[] {
  return Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
}
const CRC = crc32Table();
function crc(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}
/** 64x64 RGB: green background with a 20x30 non-green rectangle. */
function makePng(): Buffer {
  const w = 64, h = 64;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const inside = x >= 22 && x < 42 && y >= 17 && y < 47;
      const px = inside ? [200, 60, 60] : [30, 148, 27];
      row.set(px, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = makePng();
const goodCapture = async () => '... crop=20:30:22:17';

function setup(o: { generate?: CharacterGenerator; capture?: () => Promise<string>; raw?: (args: string[]) => Promise<Buffer>; apiKey?: string } = {}) {
  const charactersDir = mkdtempSync(join(tmpdir(), 'charroutes-'));
  dirs.push(charactersDir);
  const inputs: CharacterGenInput[] = [];
  const generate: CharacterGenerator =
    o.generate ?? (async (i) => { inputs.push(i); return PNG; });
  const app = buildApp({
    db: openDatabase(':memory:'),
    charactersDir,
    characterGenerator: generate,
    runFfmpegCapture: o.capture ?? goodCapture,
    runFfmpegRaw: o.raw ?? (async () => Buffer.alloc(0)),
    apiKey: o.apiKey,
  });
  return { app, charactersDir, inputs };
}
const body = { name: 'Ana', description: 'a red fox in a scarf' };

test('POST creates a character and builds a safe prompt', async () => {
  const { app, inputs, charactersDir } = setup();
  const res = await request(app).post('/api/characters').send(body);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'generated');
  assert.match(res.body.keyColor, /^0x[0-9a-f]{6}$/);
  assert.deepEqual(res.body.crop, { x: 22 - 0, y: 17 - 1, w: 20 + 0, h: 30 + 2 });
  assert.equal(res.body.imageUrl, `/api/characters/${res.body.id}/image`);
  assert.equal('imagePath' in res.body, false);
  assert.equal(JSON.stringify(res.body).includes(charactersDir), false);
  assert.match(inputs[0].prompt, /a red fox in a scarf/);
  assert.match(inputs[0].prompt, /uniform flat pure bright green \(#00FF00\) backdrop/i);
  assert.match(inputs[0].negativePrompt, /green clothing/);
  assert.doesNotMatch(inputs[0].prompt + inputs[0].negativePrompt, /muppet/i);
});

test('POST validation answers 400 and never calls the generator', async () => {
  const { app, inputs } = setup();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ description: 'd' }, 'name is required'],
    [{ name: '  ', description: 'd' }, 'name is required'],
    [{ name: 'x'.repeat(81), description: 'd' }, 'name is required'],
    [{ name: 'n' }, 'description is required'],
    [{ name: 'n', description: 'd'.repeat(501) }, 'description is required'],
    [{ name: 'n', description: 'd', seed: 1.5 }, 'seed must be an integer'],
    [{ name: 'n', description: 'd', seed: -1 }, 'seed must be an integer'],
    [{ name: 'n', description: 'd', seed: 4294967296 }, 'seed must be an integer'],
    [{ name: 'n', description: 'd', seed: '3' }, 'seed must be an integer'],
  ];
  for (const [b, msg] of cases) {
    const res = await request(app).post('/api/characters').send(b);
    assert.equal(res.status, 400, msg);
    assert.equal(res.body.error, msg);
  }
  assert.equal(inputs.length, 0);
});

test('generator and analysis failures map to 503/502/422 and leave nothing behind', async () => {
  const unavailable = setup({ generate: async () => { throw new ComfyUnavailableError('down'); } });
  let res = await request(unavailable.app).post('/api/characters').send(body);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'ComfyUI unavailable');
  assert.deepEqual(readdirSync(unavailable.charactersDir), []);

  const broken = setup({ generate: async () => { throw new Error('boom'); } });
  res = await request(broken.app).post('/api/characters').send(body);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'character generation failed: boom');
  assert.deepEqual(readdirSync(broken.charactersDir), []);

  const noCrop = setup({ capture: async () => 'nothing here' });
  res = await request(noCrop.app).post('/api/characters').send(body);
  assert.equal(res.status, 422);
  assert.match(res.body.error, /^could not analyse the generated image: /);
  assert.deepEqual(readdirSync(noCrop.charactersDir), []);
  assert.deepEqual((await request(noCrop.app).get('/api/characters')).body.characters, []);
});

test('a concurrent POST gets 429 and the flag is released afterwards (also after failure)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const { app } = setup({
    generate: async () => {
      calls++;
      if (calls === 1) await gate;
      if (calls === 2) throw new Error('boom');
      return PNG;
    },
  });
  const first = request(app).post('/api/characters').send(body).then((r) => r);
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await request(app).post('/api/characters').send(body);
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'a character is already being generated');
  release();
  assert.equal((await first).status, 201);
  assert.equal((await request(app).post('/api/characters').send(body)).status, 502);
  assert.equal((await request(app).post('/api/characters').send(body)).status, 201);
});

test('GET list newest first, status filter, get by id and id validation', async () => {
  const { app } = setup();
  const a = (await request(app).post('/api/characters').send({ ...body, name: 'A' })).body;
  await new Promise((r) => setTimeout(r, 5));
  const b = (await request(app).post('/api/characters').send({ ...body, name: 'B' })).body;
  await request(app).post(`/api/characters/${a.id}/approve`);
  const all = await request(app).get('/api/characters');
  assert.deepEqual(all.body.characters.map((c: { id: string }) => c.id), [b.id, a.id]);
  const approved = await request(app).get('/api/characters?status=approved');
  assert.deepEqual(approved.body.characters.map((c: { id: string }) => c.id), [a.id]);
  assert.equal((await request(app).get('/api/characters?status=nope')).status, 400);
  assert.equal((await request(app).get(`/api/characters/${a.id}`)).status, 200);
  const missing = await request(app).get('/api/characters/ghost');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'character not found');
  for (const bad of ['..%2Fx', 'a.b']) {
    const res = await request(app).get(`/api/characters/${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error, 'invalid character id');
  }
});

test('GET image serves the PNG; 404 for unknown id and after the file is removed', async () => {
  const { app, charactersDir } = setup();
  const c = (await request(app).post('/api/characters').send(body)).body;
  const res = await request(app).get(`/api/characters/${c.id}/image`).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (d: Buffer) => chunks.push(d));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
  assert.ok(Buffer.compare(res.body as Buffer, PNG) === 0);
  assert.equal((await request(app).get('/api/characters/ghost/image')).status, 404);
  rmSync(join(charactersDir, c.id), { recursive: true, force: true });
  assert.equal((await request(app).get(`/api/characters/${c.id}/image`)).status, 404);
});

test('approve stores mouthY, validates it and 404s for unknown ids', async () => {
  const { app } = setup();
  const c = (await request(app).post('/api/characters').send(body)).body;
  const plain = await request(app).post(`/api/characters/${c.id}/approve`);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.status, 'approved');
  const withMouth = await request(app).post(`/api/characters/${c.id}/approve`).send({ mouthY: 0.62 });
  assert.equal(withMouth.body.mouthY, 0.62);
  const bad = await request(app).post(`/api/characters/${c.id}/approve`).send({ mouthY: 2 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'mouthY must be a number between 0.05 and 0.95');
  assert.equal((await request(app).post('/api/characters/ghost/approve')).status, 404);
});

test('DELETE removes row and file; unknown id gives 404', async () => {
  const { app, charactersDir } = setup();
  const c = (await request(app).post('/api/characters').send(body)).body;
  assert.equal((await request(app).delete(`/api/characters/${c.id}`)).status, 204);
  assert.equal((await request(app).get(`/api/characters/${c.id}`)).status, 404);
  assert.equal(existsSync(join(charactersDir, c.id)), false);
  assert.equal((await request(app).delete(`/api/characters/${c.id}`)).status, 404);
});

test('auth: writes need the token, reads do not', async () => {
  const { app } = setup({ apiKey: 'secret' });
  const auth = { Authorization: 'Bearer secret' };
  assert.equal((await request(app).post('/api/characters').send(body)).status, 401);
  const c = (await request(app).post('/api/characters').set(auth).send(body)).body;
  assert.equal((await request(app).post(`/api/characters/${c.id}/approve`)).status, 401);
  assert.equal((await request(app).delete(`/api/characters/${c.id}`)).status, 401);
  assert.equal((await request(app).get('/api/characters')).status, 200);
  assert.equal((await request(app).get(`/api/characters/${c.id}/image`)).status, 200);
});

test('POST passes runFfmpegRaw to the analysis so new characters get a mouth lookup', async () => {
  let calls = 0;
  const { app } = setup({ raw: async () => { calls++; return Buffer.alloc(0); } });
  const res = await request(app).post('/api/characters').send(body);
  assert.equal(res.status, 201);
  assert.equal(calls, 1);
  assert.equal(res.body.mouth, null);
});

test('reanalyze rewrites the analysis from the stored PNG', async () => {
  let calls = 0;
  const { app, charactersDir } = setup({ raw: async () => { calls++; return Buffer.alloc(0); } });
  const c = (await request(app).post('/api/characters').send(body)).body;
  const before = calls;
  const res = await request(app).post(`/api/characters/${c.id}/reanalyze`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, c.id);
  assert.deepEqual(res.body.crop, c.crop);
  assert.ok('mouth' in res.body);
  assert.equal(calls, before + 1, 'reanalyze passes runFfmpegRaw');
  assert.equal('imagePath' in res.body, false);
  assert.equal(JSON.stringify(res.body).includes(charactersDir), false);
});

test('reanalyze: 400 invalid id, 404 unknown, 422 on analysis failure, token guarded', async () => {
  const { app } = setup();
  assert.equal((await request(app).post('/api/characters/bad.id/reanalyze')).status, 400);
  assert.equal((await request(app).post('/api/characters/ghost/reanalyze')).status, 404);

  let fail = false;
  const f = setup({ capture: async () => { if (fail) throw new Error('ffmpeg down'); return '... crop=20:30:22:17'; } });
  const c = (await request(f.app).post('/api/characters').send(body)).body;
  fail = true;
  const res = await request(f.app).post(`/api/characters/${c.id}/reanalyze`);
  assert.equal(res.status, 422);
  assert.match(res.body.error, /could not analyse the stored image: ffmpeg down/);

  const g = setup({ apiKey: 'k' });
  assert.equal((await request(g.app).post('/api/characters/ghost/reanalyze')).status, 401);
});
