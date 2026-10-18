import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { musicMixArgs, type MusicMixOptions } from '../src/media/ffmpeg';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import { wavFromPcm } from '../src/media/wav';
import type { ComfyClient } from '../src/clients/comfy';
import type { OllamaClient } from '../src/clients/ollama';
import type { PiperClient } from '../src/clients/piper';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vs-music-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, 'audio-bytes');
  return p;
}

test('musicMixArgs builds the ducking graph (music input 2, sidechain = narration)', () => {
  const args = musicMixArgs({ video: 'v.mp4', audio: 'n.wav', music: 'm.mp3', out: 'f.mp4', musicVolume: 0.25 });
  assert.deepEqual(args, [
    '-i', 'v.mp4', '-i', 'n.wav', '-i', 'm.mp3',
    '-filter_complex',
    "[2:a]volume=0.25[m];[m][1:a]sidechaincompress=threshold=0.15:ratio=8:attack=50:release=400[bg];[1:a][bg]amix=inputs=2:duration=first:dropout_transition=0[a]",
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    'f.mp4',
  ]);
});

test('musicMixArgs guards the volume range', () => {
  for (const bad of [-0.1, 0, 1.01]) {
    assert.throws(
      () => musicMixArgs({ video: 'v', audio: 'n', music: 'm', out: 'f', musicVolume: bad }),
      /musicVolume/,
    );
  }
});

const fakeOllama = {
  chatJson: async () => ({ scenes: [{ title: 'A', narration: 'na', visualPrompt: 'va' }] }),
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

function setup(opts?: { musicDir?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-music-r-'));
  dirs.push(dir);
  const app = buildApp({
    db: openDatabase(':memory:'),
    envDefaults: loadEnvDefaults({}),
    ollama: fakeOllama,
    comfy: fakeComfy,
    piper: fakePiper,
    ffmpeg: async (a: string[]) => writeFileSync(a[a.length - 1], 'fake'),
    musicDir: opts?.musicDir,
    jobs: { workDir: dir, autoStart: false },
  });
  return app;
}

async function draftId(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await request(app).post('/api/pipeline/draft').send({ text: 'article' });
  assert.equal(res.status, 201);
  return res.body.id as string;
}

test('approve with music persisted only when inside the library; rejects outside / missing', async () => {
  const musicDir = mkdtempSync(join(tmpdir(), 'vs-music-lib-'));
  dirs.push(musicDir);
  const app = setup({ musicDir });
  const id = await draftId(app);
  const music = join(musicDir, 'bgm.mp3');
  writeFileSync(music, 'audio-bytes');

  const ok = await request(app).post(`/api/pipeline/draft/${id}/approve`).set('Accept', 'application/json').send({ music });
  assert.equal(ok.status, 202, ok.text);
  const job = await request(app).get(`/api/jobs/${ok.body.jobId}`);
  assert.equal(job.status, 200);
  assert.equal(job.body.options?.music, music);

  // A file inside the library that is missing → 400.
  const id2 = await draftId(app);
  const missing = await request(app)
    .post(`/api/pipeline/draft/${id2}/approve`)
    .set('Accept', 'application/json')
    .send({ music: join(musicDir, 'nope.mp3') });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /music/i);

  // A path that escapes the library dir → 400 (the §5.2 hardening).
  const id3 = await draftId(app);
  const outside = await request(app)
    .post(`/api/pipeline/draft/${id3}/approve`)
    .set('Accept', 'application/json')
    .send({ music: join(__dirname, '..', 'outside-the-library.mp3') });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /escape|outside|configured/i);
});

test('approve without a configured music library rejects the music option', async () => {
  const app = setup(); // no musicDir
  const id = await draftId(app);
  const res = await request(app)
    .post(`/api/pipeline/draft/${id}/approve`)
    .set('Accept', 'application/json')
    .send({ music: '/any/path.mp3' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /configured|library|MUSIC_DIR/i);
});

test('approve rejects out-of-range or wrong-typed musicVolume and unknown keys', async () => {
  const app = setup();
  const music = tmp('bgm.mp3');
  for (const body of [
    { music, musicVolume: 0 },
    { music, musicVolume: 1.5 },
    { music, musicVolume: 'loud' },
    { bgm: 'x' },
  ]) {
    const id = await draftId(app);
    const res = await request(app).post(`/api/pipeline/draft/${id}/approve`).set('Accept', 'application/json').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('existing jobs DBs without an options column are migrated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-music-m-'));
  dirs.push(dir);
  const file = join(dir, 'legacy.db');
  // Create a pre-E1 jobs table (no options column) with a row, then open with the real schema.
  {
    const { DatabaseSync } = require('node:sqlite');    const legacy = new DatabaseSync(file);
    legacy.exec(
      `CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress REAL NOT NULL,
        error TEXT,
        output_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      )`,
    );
    legacy.prepare('INSERT INTO jobs (id, draft_id, status, stage, progress, created_at, updated_at) VALUES (?,?,?,?,1,?,?)')
      .run('j1', 'd1', 'done', 'done', new Date().toISOString(), new Date().toISOString());
    legacy.close();
  }
  const db = openDatabase(file);
  const cols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('options'), `jobs.options missing after migration; columns: ${cols.join(',')}`);
  const row = db.prepare('SELECT options FROM jobs WHERE id = ?').get('j1') as { options: unknown };
  assert.equal(row.options, null);
});

export type { MusicMixOptions };
