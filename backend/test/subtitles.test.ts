import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildSrt, sceneCues, type SubtitleCue } from '../src/pipeline/subtitles';
import { burnSubtitlesArgs } from '../src/media/ffmpeg';
import { openDatabase } from '../src/db/connection';
import { createDraft } from '../src/pipeline/draftRepository';
import { createJob } from '../src/jobs/jobRepository';
import { createExecute } from '../src/pipeline/orchestrator';
import { wavFromPcm, wavDurationSec } from '../src/media/wav';
import type { ComfyClient } from '../src/clients/comfy';
import type { PiperClient } from '../src/clients/piper';
import type { Escaleta } from '../src/pipeline/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('buildSrt emits RFC-compliant cues with millisecond precision', () => {
  const cues: SubtitleCue[] = [
    { text: '  Hola mundo  ', startSec: 0, endSec: 2.5 },
    { text: 'Segunda línea', startSec: 4.0625, endSec: 6.475 },
  ];
  assert.equal(
    buildSrt(cues),
    '1\n00:00:00,000 --> 00:00:02,500\nHola mundo\n\n' +
      '2\n00:00:04,063 --> 00:00:06,475\nSegunda línea\n',
  );
});

test('buildSrt rejects malformed cues', () => {
  assert.throws(() => buildSrt([]), /at least one cue/);
  assert.throws(() => buildSrt([{ text: '   ', startSec: 0, endSec: 1 }]), /text/);
  assert.throws(() => buildSrt([{ text: 'a', startSec: 2, endSec: 1 }]), /end/);
  assert.throws(() => buildSrt([{ text: 'a', startSec: -1, endSec: 1 }]), /start/);
});

test('sceneCues places each scene after the previous durations and silences', () => {
  const cues = sceneCues([0.5, 0.75, 1], 33 / 16, ['n0', 'n1', 'n2']);
  assert.deepEqual(cues, [
    { text: 'n0', startSec: 0, endSec: 0.5 },
    { text: 'n1', startSec: 0.5 + 33 / 16, endSec: 0.5 + 33 / 16 + 0.75 },
    { text: 'n2', startSec: 0.5 + 33 / 16 + 0.75 + 33 / 16, endSec: 0.5 + 33 / 16 + 0.75 + 33 / 16 + 1 },
  ]);
});

test('burnSubtitlesArgs re-encodes with the subtitles filter and copy audio', () => {
  const path = '/tmp/with space:colon.srt';
  const args = burnSubtitlesArgs({ input: 'in.mp4', srt: path, out: 'out.mp4' });
  assert.deepEqual(args, [
    '-i', 'in.mp4',
    '-vf', `subtitles=${path.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    'out.mp4',
  ]);
  assert.match(args[args.indexOf('-vf') + 1], /subtitles=\/tmp\/with space\\:colon\.srt/);
});

test('burnSubtitlesArgs accepts an optional force_style for a 9:16 portrait frame', () => {
  const style = 'PlayResX=720,PlayResY=1280,FontSize=13,Alignment=2';
  const args = burnSubtitlesArgs({ input: 'in.mp4', srt: '/s.srt', out: 'out.mp4', style });
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /^subtitles=\/s\.srt:force_style='/);
  assert.ok(vf.endsWith(`'`), 'force_style value is quoted');
  assert.match(vf, /PlayResX=720,PlayResY=1280/);
});

// ---- orchestrator flow with subtitles ----
const fmt = { rate: 16000, width: 2, channels: 1 };
const SCENE_SECONDS = [0.5, 0.75, 1];
const scenes: Escaleta = [
  { scene: 1, title: 'T0', narration: 'narr 0', visualPrompt: 'v0', voice: 'male' },
  { scene: 2, title: 'T1', narration: 'narr 1', visualPrompt: 'v1', voice: 'female' },
  { scene: 3, title: 'T2', narration: 'narr 2', visualPrompt: 'v2', voice: 'male' },
];

function subsHarness(opts: { subtitles?: boolean; music?: string } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-subs-'));
  dirs.push(workDir);
  const db = openDatabase(':memory:');
  const draft = createDraft(db, {
    sourceKind: 'text',
    sourceRef: 'x',
    language: 'es',
    voiceA: 'male',
    voiceB: 'female',
    mix: true,
    escaleta: scenes,
  });
  const jobOpts =
    opts.music !== undefined || opts.subtitles !== undefined
      ? { ...(opts.music ? { music: opts.music } : {}), ...(opts.subtitles !== undefined ? { subtitles: opts.subtitles } : {}) }
      : undefined;
  const job = createJob(db, draft.id, undefined, undefined, jobOpts);
  const comfy = {
    submit: async () => 'p1',
    waitForCompletion: async () => ({ '9': { images: [{ filename: 'o.png' }], gifs: [{ filename: 'o.mp4' }] } }),
    download: async () => Buffer.from('video'),
    downloadToFile: async (_f: unknown, dest: string) => { writeFileSync(dest, 'video'); },
    uploadImage: async (_d: Buffer, name: string) => name,
    interrupt: async () => {},
  } as unknown as ComfyClient;
  const piper = {
    synthesize: async () => wavFromPcm(Buffer.alloc(Math.round(SCENE_SECONDS[0] * fmt.rate) * 2), fmt),
  } as unknown as PiperClient;
  const ffmpegCalls: string[][] = [];
  const ffmpeg = async (args: string[]) => {
    ffmpegCalls.push(args);
    writeFileSync(args[args.length - 1], `out:${basename(args[args.length - 1])}`);
  };
  const execute = createExecute({ db, resolveComfy: () => comfy, resolvePiper: () => piper, ffmpeg });
  return { workDir, job, execute, ffmpegCalls, db };
}

test('default (subtitles on) burns the SRT after the mux and keeps final.mp4 as output', async () => {
  const h = subsHarness();
  const { outputPath } = await h.execute(h.job, { signal: new AbortController().signal, workDir: h.workDir, emit: () => {} });
  assert.equal(outputPath, join(h.workDir, 'final.mp4'));
  const cover = h.ffmpegCalls[h.ffmpegCalls.length - 1];
  assert.equal(cover[cover.length - 1], join(h.workDir, 'cover.jpg'));
  const burn = h.ffmpegCalls[h.ffmpegCalls.length - 2];
  assert.ok(burn.includes('-vf'), 'burn step must re-encode (subtitles filter)');
  assert.match(burn[burn.indexOf('-vf') + 1], /^subtitles=/);
  assert.match(burn[burn.indexOf('-vf') + 1], /subtitles\.srt/);
  const srt = readFileSync(join(h.workDir, 'subtitles.srt'), 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:00,500/);
  assert.match(srt, /narr 2/);
  const mux = h.ffmpegCalls[h.ffmpegCalls.length - 3];
  assert.equal(mux[mux.length - 1], join(h.workDir, 'muxed.mp4'));
});

test('subtitles: false keeps the classic mux tail untouched', async () => {
  const h = subsHarness({ subtitles: false });
  const { outputPath } = await h.execute(h.job, { signal: new AbortController().signal, workDir: h.workDir, emit: () => {} });
  assert.equal(outputPath, join(h.workDir, 'final.mp4'));
  assert.ok(!h.ffmpegCalls.some((a) => a.includes('-vf') && a[a.indexOf('-vf') + 1]?.startsWith('subtitles=')));
  const mux = h.ffmpegCalls[h.ffmpegCalls.length - 2];
  assert.ok(mux.includes('-c:v') && mux[mux.indexOf('-c:v') + 1] === 'copy', 'classic tail copies the video stream');
  const cover = h.ffmpegCalls[h.ffmpegCalls.length - 1];
  assert.equal(cover[cover.length - 1], join(h.workDir, 'cover.jpg'));
});

test('music + subtitles: music mix first (muxed.mp4), burn second (final.mp4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-subs-m-'));
  dirs.push(dir);
  const music = join(dir, 'bgm.mp3');
  writeFileSync(music, 'audio');
  const h = subsHarness({ music });
  const ctx = { signal: new AbortController().signal, workDir: h.workDir, emit: () => {} };
  await h.execute(h.job, ctx);
  const calls = h.ffmpegCalls;
  const tail = calls.slice(-3);
  assert.deepEqual(tail[0].slice(0, 6), [
    '-i', join(h.workDir, 'video.mp4'),
    '-i', join(h.workDir, 'audio', 'narration.wav'),
    '-i', music,
  ]);
  assert.match(tail[0][tail[0].indexOf('-filter_complex') + 1], /sidechaincompress/);
  assert.equal(tail[0][tail[0].length - 1], join(h.workDir, 'muxed.mp4'));
  const burn = tail[1];
  assert.equal(burn[1], join(h.workDir, 'muxed.mp4'));
  assert.match(burn[burn.indexOf('-vf') + 1], /^subtitles=/);
  assert.equal(burn[burn.length - 1], join(h.workDir, 'final.mp4'));
  const cover = tail[2];
  assert.equal(cover[cover.length - 1], join(h.workDir, 'cover.jpg'));
});
