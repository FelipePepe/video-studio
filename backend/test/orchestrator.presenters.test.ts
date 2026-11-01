import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDatabase } from '../src/db/connection';
import { createDraft } from '../src/pipeline/draftRepository';
import { createJob } from '../src/jobs/jobRepository';
import { createExecute, sceneFrameBounds, type PresenterAssets } from '../src/pipeline/orchestrator';
import { wavFromPcm } from '../src/media/wav';
import type { ComfyClient } from '../src/clients/comfy';
import type { PiperClient } from '../src/clients/piper';
import type { EmitInput } from '../src/jobs/types';
import type { ApproveOptions, Escaleta } from '../src/pipeline/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fmt = { rate: 16000, width: 2, channels: 1 };
const SCENE_SECONDS = [0.5, 0.75, 1];
const FPS = 24;
const GAP_SEC = 33 / 16;

// Loud square wave: every mouth frame is above the open threshold.
const loudWav = (sec: number) => {
  const n = Math.round(sec * fmt.rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return wavFromPcm(pcm, fmt);
};

const SPEAKERS = ['A', 'B', 'A'] as const;
const scenes = (withSpeaker: boolean): Escaleta =>
  SPEAKERS.map((sp, i) => ({
    scene: i + 1,
    title: `T${i}`,
    narration: `narration ${i}`,
    visualPrompt: `visual ${i}`,
    voice: i % 2 ? 'female' : 'male',
    ...(withSpeaker ? { speaker: sp } : {}),
  }));

const has = (args: string[], sub: string) => args.some((a) => a.includes(sub));

interface Opts {
  presenters?: boolean;
  speakers?: boolean;
  noAssets?: boolean;
  failI2V?: number[];
  assetsReject?: boolean;
  throwOn?: string;
  abortOnSprite?: boolean;
}

function harness(opts: Opts = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-pres-'));
  dirs.push(workDir);
  const db = openDatabase(':memory:');
  const draft = createDraft(db, {
    sourceKind: 'text', sourceRef: 'x', language: 'es', voiceA: 'male', voiceB: 'female', mix: true,
    escaleta: scenes(opts.speakers !== false),
  });
  const options: ApproveOptions | null =
    opts.presenters === false ? null : { presenters: { mode: 'volume', a: 'ana', b: 'leo' } };
  const job = createJob(db, draft.id, undefined, undefined, options);
  const controller = new AbortController();
  const events: EmitInput[] = [];
  const ctx = { signal: controller.signal, workDir, emit: (e: EmitInput) => events.push(e) };

  let i2v = 0;
  let t2v = 0;
  const comfy = {
    submit: async (wf: Record<string, { class_type: string }>) => {
      const isI2V = Object.values(wf).some((n) => n.class_type === 'WanVideoImageToVideoEncode');
      if (isI2V) {
        const idx = i2v++;
        if (opts.failI2V?.includes(idx)) throw new Error('GPU exploded');
      } else t2v++;
      return `p${i2v + t2v}`;
    },
    waitForCompletion: async () => ({
      '9': { images: [{ filename: 'a.png', subfolder: 's', type: 'output' }], gifs: [{ filename: 'a.mp4', subfolder: 's', type: 'output' }] },
    }),
    download: async () => Buffer.from('png'),
    downloadToFile: async (_f: unknown, dest: string) => writeFileSync(dest, 'mp4'),
    uploadImage: async (_d: Buffer, name: string) => name,
    queueIds: async () => ({ running: [], pending: [] }),
    interrupt: async () => undefined,
    deletePrompt: async () => undefined,
  };
  let tts = 0;
  const piper = { synthesize: async () => loudWav(SCENE_SECONDS[tts++ % 3]) };
  const ffmpegCalls: string[][] = [];
  const ffmpeg = async (args: string[]) => {
    ffmpegCalls.push(args);
    if (opts.abortOnSprite && has(args, 'chromakey')) {
      controller.abort();
      throw new Error('killed');
    }
    if (opts.throwOn && has(args, opts.throwOn)) throw new Error(`boom ${opts.throwOn}`);
    writeFileSync(args[args.length - 1], `out:${basename(args[args.length - 1])}`);
  };
  const execute = createExecute({
    db,
    resolveComfy: () => comfy as unknown as ComfyClient,
    resolvePiper: () => piper as unknown as PiperClient,
    ffmpeg,
    ...(opts.noAssets
      ? {}
      : {
          presenterAssets: async (id: string): Promise<PresenterAssets> => {
            if (opts.assetsReject) throw new Error('no such character');
            return { imagePath: `/x/${id}.png`, keyColor: '0x1e941b', crop: { x: 10, y: 20, w: 300, h: 400 } };
          },
        }),
  });
  const sprites = () => ffmpegCalls.filter((a) => has(a, 'chromakey'));
  const clips = () => ffmpegCalls.filter((a) => has(a, 'qtrle'));
  const overlays = () => ffmpegCalls.filter((a) => has(a, '[2:v]'));
  const frames = (a: string[]) => Number(a[a.indexOf('-frames:v') + 1]);
  const warnings = () => events.filter((e) => e.warning).map((e) => e.message ?? '');
  const muxCall = () => ffmpegCalls.find((a) => a[a.length - 1].endsWith('muxed.mp4'))!;
  return { workDir, execute, job, ctx, events, ffmpegCalls, sprites, clips, overlays, frames, warnings, muxCall };
}

test('sceneFrameBounds sums exactly to round(total * fps) with no drift', () => {
  const b = sceneFrameBounds([0.5, 0.75, 1], [2.0625, 2.0625, 0], FPS);
  const total = 0.5 + 0.75 + 1 + 2 * 2.0625;
  assert.equal(b.reduce((a, x) => a + x.speechFrames + x.gapFrames, 0), Math.round(total * FPS));
  for (const x of b) {
    assert.ok(Number.isInteger(x.speechFrames) && x.speechFrames >= 0);
    assert.ok(Number.isInteger(x.gapFrames) && x.gapFrames >= 0);
  }
  const n = 20;
  const big = sceneFrameBounds(Array(n).fill(3.3), Array.from({ length: n }, (_, i) => (i < n - 1 ? 2.0625 : 0)), FPS);
  // Same accumulation order as the production code: the total is an exact .5 tie in frames.
  let bigTotal = 0;
  for (let i = 0; i < n; i++) bigTotal += 3.3 + (i < n - 1 ? 2.0625 : 0);
  assert.equal(big.reduce((a, x) => a + x.speechFrames + x.gapFrames, 0), Math.round(bigTotal * FPS));
  for (const x of big) {
    assert.ok(Number.isInteger(x.speechFrames) && x.speechFrames >= 0);
    assert.ok(Number.isInteger(x.gapFrames) && x.gapFrames >= 0);
  }
});

test('happy path renders sprites, two clips of equal length and one overlay before the mux', async () => {
  const h = harness();
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.equal(outputPath, join(h.workDir, 'final.mp4'));
  const stages = h.events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.deepEqual(stages, ['tts', 'images', 'transitions', 'presenters', 'assemble']);
  const progress = h.events.map((e) => e.progress ?? 0);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  assert.ok(progress.every((p) => p >= 0 && p <= 1));

  const sprites = h.sprites();
  assert.equal(sprites.length, 6);
  for (const s of sprites) {
    assert.ok(has(s, '-frames:v'));
    assert.ok(has(s, 'crop=300:400:10:20'));
    assert.ok(has(s, '0x1e941b'));
  }
  const T = Math.round((SCENE_SECONDS.reduce((a, b) => a + b, 0) + 2 * GAP_SEC) * FPS);
  const clips = h.clips();
  assert.equal(clips.length, 2);
  assert.equal(h.frames(clips[0]), T);
  assert.equal(h.frames(clips[1]), T);

  const overlays = h.overlays();
  assert.equal(overlays.length, 1);
  assert.ok(has(overlays[0], '[2:v]scale=-2:288'));
  assert.equal(overlays[0][overlays[0].indexOf('-i') + 1], join(h.workDir, 'video.mp4'));
  assert.equal(overlays[0][overlays[0].length - 1], join(h.workDir, 'video_p.mp4'));
  assert.equal(h.muxCall()[h.muxCall().indexOf('-i') + 1], join(h.workDir, 'video_p.mp4'));
});

test('concat lists keep the silent presenter closed during the other presenter scene', async () => {
  const h = harness();
  await h.execute(h.job, h.ctx);
  const a = readFileSync(join(h.workDir, 'presenters', 'A.txt'), 'utf8');
  const b = readFileSync(join(h.workDir, 'presenters', 'B.txt'), 'utf8');
  assert.match(a, /A_(open|mid)\.png/);
  const bLines = b.trim().split('\n');
  assert.match(bLines[0], /B_closed\.png/);
  const firstDuration = Number(bLines[1].replace('duration ', ''));
  assert.ok(firstDuration >= SCENE_SECONDS[0], `closed for the whole of scene 0 (got ${firstDuration})`);
});

test('a hard-cut transition shrinks the timeline by its gap and stays exact', async () => {
  const h = harness({ failI2V: [0] });
  await h.execute(h.job, h.ctx);
  const T = Math.round((SCENE_SECONDS.reduce((a, b) => a + b, 0) + GAP_SEC) * FPS);
  const clips = h.clips();
  assert.equal(h.frames(clips[0]), T);
  assert.equal(h.frames(clips[1]), T);
});

test('is inactive without the option', async () => {
  const h = harness({ presenters: false });
  await h.execute(h.job, h.ctx);
  assert.equal(h.sprites().length + h.clips().length + h.overlays().length, 0);
  assert.ok(!h.events.some((e) => e.type === 'stage' && e.stage === 'presenters'));
});

test('skips with a warning when no scene has a speaker', async () => {
  const h = harness({ speakers: false });
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.ok(outputPath.endsWith('final.mp4'));
  assert.ok(!h.events.some((e) => e.type === 'stage' && e.stage === 'presenters'));
  assert.ok(h.warnings().some((m) => m.includes('no speakers')));
  assert.equal(h.sprites().length, 0);
});

test('skips with a warning when no character store is configured', async () => {
  const h = harness({ noAssets: true });
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.ok(outputPath.endsWith('final.mp4'));
  assert.ok(h.warnings().some((m) => m.includes('no character store')));
  assert.equal(h.sprites().length, 0);
});

test('degrades when the asset lookup rejects', async () => {
  const h = harness({ assetsReject: true });
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.ok(outputPath.endsWith('final.mp4'));
  assert.ok(h.warnings().some((m) => m.includes('presenters failed')));
  assert.equal(h.overlays().length, 0);
});

test('degrades when a sprite ffmpeg call fails', async () => {
  const h = harness({ throwOn: 'chromakey' });
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.ok(outputPath.endsWith('final.mp4'));
  assert.ok(h.warnings().some((m) => m.includes('presenters failed')));
  assert.equal(h.overlays().length, 0);
  assert.equal(h.muxCall()[h.muxCall().indexOf('-i') + 1], join(h.workDir, 'video.mp4'));
});

test('degrades when the overlay fails and muxes the plain video', async () => {
  const h = harness({ throwOn: '[2:v]' });
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.ok(outputPath.endsWith('final.mp4'));
  assert.ok(h.warnings().some((m) => m.includes('overlay failed')));
  assert.equal(h.muxCall()[h.muxCall().indexOf('-i') + 1], join(h.workDir, 'video.mp4'));
});

test('an abort during the presenters stage is not degraded', async () => {
  const h = harness({ abortOnSprite: true });
  await assert.rejects(h.execute(h.job, h.ctx), (e: Error) => e.name === 'AbortError');
  assert.ok(!h.warnings().some((m) => m.includes('presenters failed')));
});
