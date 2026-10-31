import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import request from 'supertest';
import { verticalCropArgs, coverArgs } from '../src/media/ffmpeg';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import { createDraft } from '../src/pipeline/draftRepository';
import { createJob, markDone } from '../src/jobs/jobRepository';
import { createExecute } from '../src/pipeline/orchestrator';
import { wavFromPcm } from '../src/media/wav';
import type { ComfyClient } from '../src/clients/comfy';
import type { PiperClient } from '../src/clients/piper';
import type { Escaleta } from '../src/pipeline/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('verticalCropArgs center-crops 16:9 to 9:16 and re-encodes at 720x1280', () => {
  assert.deepEqual(verticalCropArgs({ input: 'in.mp4', out: 'out.mp4' }), [
    '-i', 'in.mp4',
    '-vf', 'crop=ih*9/16:ih,scale=720:1280',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    'out.mp4',
  ]);
});

test('coverArgs extracts one frame at the given time (fast seek before the input)', () => {
  assert.deepEqual(coverArgs({ input: 'in.mp4', atSec: 1.25, out: 'cover.jpg' }), [
    '-ss', '1.25', '-i', 'in.mp4', '-frames:v', '1', '-q:v', '3', 'cover.jpg',
  ]);
});

const fmt = { rate: 16000, width: 2, channels: 1 };
const scenes: Escaleta = [
  { scene: 1, title: 'T0', narration: 'narr 0', visualPrompt: 'v0', voice: 'male' },
  { scene: 2, title: 'T1', narration: 'narr 1', visualPrompt: 'v1', voice: 'female' },
];

function vHarness(opts?: { vertical?: boolean; subtitles?: boolean }) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-vert-'));
  dirs.push(workDir);
  const db = openDatabase(':memory:');
  const draft = createDraft(db, {
    sourceKind: 'text', sourceRef: 'x', language: 'es', voiceA: 'male', voiceB: 'female', mix: false, escaleta: scenes,
  });
  const jobOpts: { vertical?: boolean; subtitles?: boolean } = {};
  if (opts?.vertical !== undefined) jobOpts.vertical = opts.vertical;
  if (opts?.subtitles !== undefined) jobOpts.subtitles = opts.subtitles;
  const job = createJob(db, draft.id, undefined, undefined, Object.keys(jobOpts).length ? jobOpts : undefined);
  const comfy = {
    submit: async () => 'p1',
    waitForCompletion: async () => ({ '9': { images: [{ filename: 'o.png' }], gifs: [{ filename: 'o.mp4' }] } }),
    download: async () => Buffer.from('video'),
    downloadToFile: async (_f: unknown, dest: string) => { writeFileSync(dest, 'video'); },
    uploadImage: async (_d: Buffer, name: string) => name,
    interrupt: async () => {},
  } as unknown as ComfyClient;
  const piper = {
    synthesize: async () => wavFromPcm(Buffer.alloc(8000), fmt),
  } as unknown as PiperClient;
  const calls: string[][] = [];
  const ffmpeg = async (args: string[]) => {
    calls.push(args);
    writeFileSync(args[args.length - 1], `out:${basename(args[args.length - 1])}`);
  };
  const execute = createExecute({ db, resolveComfy: () => comfy, resolvePiper: () => piper, ffmpeg });
  return { workDir, job, execute, calls };
}

test('vertical on: crops final.mp4 to final_v.mp4 and always extracts cover.jpg at the film midpoint', async () => {
  const h = vHarness({ vertical: true, subtitles: false });
  const ctx = { signal: new AbortController().signal, workDir: h.workDir, emit: () => {} };
  const res = await h.execute(h.job, ctx);
  assert.equal(res.outputPath, join(h.workDir, 'final.mp4'));
  const tail = h.calls.slice(-2);
  const crop = tail[0];
  assert.equal(crop[1], join(h.workDir, 'final.mp4'));
  assert.match(crop[3], /crop=.*scale=720:1280/);
  assert.equal(crop[crop.length - 1], join(h.workDir, 'final_v.mp4'));
  const cover = tail[1];
  assert.equal(cover[0], '-ss', 'input-side fast seek');
  assert.equal(cover[3], join(h.workDir, 'final.mp4'));
  assert.match(cover[1], /^\d+(\.\d+)?$/);
  assert.equal(cover[cover.length - 1], join(h.workDir, 'cover.jpg'));
  assert.equal(readBack(join(h.workDir, 'final_v.mp4')), 'out:final_v.mp4');
  assert.equal(readBack(join(h.workDir, 'cover.jpg')), 'out:cover.jpg');
});

test('vertical off (default) still extracts cover.jpg but never crops', async () => {
  const h = vHarness();
  const ctx = { signal: new AbortController().signal, workDir: h.workDir, emit: () => {} };
  await h.execute(h.job, ctx);
  assert.equal(readBack(join(h.workDir, 'cover.jpg')), 'out:cover.jpg');
  assert.throws(() => readBack(join(h.workDir, 'final_v.mp4')), /no such/i);
  assert.ok(!h.calls.some((a) => a.includes('final_v.mp4')));
});

test('vertical + subtitles: 16:9 burn(final), then ONE chained crop+scale+subtitles pass for 9:16 (never clipped)', async () => {
  const h = vHarness({ vertical: true });
  const ctx = { signal: new AbortController().signal, workDir: h.workDir, emit: () => {} };
  await h.execute(h.job, ctx);
  const tail = h.calls.slice(-3);
  assert.equal(tail.length, 3, 'burn(16:9) + chained vertical(9:16) + cover');
  assert.match(tail[0][tail[0].indexOf('-vf') + 1], /^subtitles=/);
  assert.equal(tail[0][tail[0].length - 1], join(h.workDir, 'final.mp4'), '16:9 master still final.mp4');
  assert.equal(tail[0][1], join(h.workDir, 'muxed.mp4'), '16:9 burn reads the sub-free base');
  const vsub = tail[1][tail[1].indexOf('-vf') + 1];
  assert.match(vsub, /^crop=ih\*9\/16:ih,scale=720:1280,subtitles=/, 'one chained filter, not two encodes');
  assert.match(vsub, /force_style=/, '9:16 subtitles use a portrait-tuned force_style');
  assert.equal(tail[1][1], join(h.workDir, 'muxed.mp4'), 'vertical pass reads the sub-free base, NOT the burned master');
  assert.equal(tail[1][tail[1].length - 1], join(h.workDir, 'final_v.mp4'));
  assert.ok(!h.calls.some((a) => a[a.length - 1] === join(h.workDir, 'base_v.mp4')), 'no intermediate base_v re-encode');
  assert.equal(tail[2][0], '-ss', 'cover fast-seeks on the input side');
  assert.equal(tail[2][tail[2].length - 1], join(h.workDir, 'cover.jpg'));
});

const readBack = (p: string) => readFileSync(p, 'utf8');

// ----- route variant -----
function setupRoutes() {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-variant-r-'));
  dirs.push(workDir);
  const db = openDatabase(':memory:');
  const draft = createDraft(db, { sourceKind: 'text', sourceRef: 'x', language: 'es', voiceA: 'male', voiceB: 'female', mix: false, escaleta: [] });
  const app = buildApp({ db, envDefaults: loadEnvDefaults({}), jobs: { workDir, execute: async (job) => ({ outputPath: join(workDir, `final_${job.id}.mp4`) }) } });
  const job = createJob(db, draft.id);
  const finalPath = join(workDir, `final_${job.id}.mp4`);
  writeFileSync(finalPath, 'final-bytes');
  writeFileSync(join(workDir, 'final_v.mp4'), 'vertical-bytes');
  writeFileSync(join(workDir, 'cover.jpg'), 'cover-bytes');
  markDone(db, job.id, finalPath);
  return { app, workDir, jobId: job.id };
}

test('GET /api/jobs/:id/output serves the variant requested (default mp4)', async () => {
  const { app, jobId, workDir } = setupRoutes();
  const def = await request(app).get(`/api/jobs/${jobId}/output`);
  assert.equal(def.status, 200);
  assert.match(def.headers['content-type'], /video\/mp4/);
  assert.equal(readFileSync(join(workDir, `final_${jobId}.mp4`), 'utf8'), 'final-bytes');
  const v = await request(app).get(`/api/jobs/${jobId}/output?variant=vertical`);
  assert.equal(v.status, 200);
  assert.match(v.headers['content-type'], /video\/mp4/);

  const c = await request(app).get(`/api/jobs/${jobId}/output?variant=cover`);
  assert.equal(c.status, 200);
  assert.match(c.headers['content-type'], /image\/jpeg/);

  // sendFile() streams the body; assert the served artifacts exist on disk with the expected bytes.
  assert.equal(readFileSync(join(workDir, 'final_v.mp4'), 'utf8'), 'vertical-bytes');
  assert.equal(readFileSync(join(workDir, 'cover.jpg'), 'utf8'), 'cover-bytes');
});

test('GET /api/jobs/:id/output rejects unknown variants and missing files', async () => {
  const { app, jobId, workDir } = setupRoutes();
  assert.equal((await request(app).get(`/api/jobs/${jobId}/output?variant=bogus`)).status, 400);
  // Remove the vertical file: variant must 404, default still works.
  rmSync(join(workDir, 'final_v.mp4'));
  assert.equal((await request(app).get(`/api/jobs/${jobId}/output?variant=vertical`)).status, 404);
  assert.equal((await request(app).get(`/api/jobs/${jobId}/output`)).status, 200);
});
