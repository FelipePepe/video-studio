import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDatabase } from '../src/db/connection';
import { createDraft } from '../src/pipeline/draftRepository';
import { createJob } from '../src/jobs/jobRepository';
import { createExecute, removePartialFfmpegOutput } from '../src/pipeline/orchestrator';
import { ContentCache } from '../src/pipeline/contentCache';
import {
  burnSubtitlesArgs,
  concatArgs,
  coverArgs,
  extractFrameArgs,
  kenBurnsArgs,
  muxAudioArgs,
  musicMixArgs,
  normalizeClipArgs,
  verticalCropArgs,
  xfadeArgs,
} from '../src/media/ffmpeg';
import { parseWav, wavDurationSec, wavFromPcm } from '../src/media/wav';
import type { ComfyClient } from '../src/clients/comfy';
import type { PiperClient } from '../src/clients/piper';
import type { EmitInput, Job } from '../src/jobs/types';
import type { Escaleta } from '../src/pipeline/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fmt = { rate: 16000, width: 2, channels: 1 };
const wavOf = (sec: number) => wavFromPcm(Buffer.alloc(Math.round(sec * fmt.rate) * 2), fmt);
const SCENE_SECONDS = [0.5, 0.75, 1];

const scenes = (n: number): Escaleta =>
  Array.from({ length: n }, (_, i) => ({
    scene: i + 1,
    title: `T${i}`,
    narration: `narration ${i}`,
    visualPrompt: `visual ${i}`,
    voice: i % 2 ? 'female' : 'male',
  }));

interface Opts {
  sceneCount?: number;
  failI2V?: number[];
  failT2V?: number;
  failTts?: number;
  abortAfterTts?: number;
  abortDuringWait?: boolean;
  queueRunning?: boolean;
  queuePending?: boolean;
  cacheDir?: string;
  comfySteps?: Array<{ value: number; max: number }>;
}

function harness(opts: Opts = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'vs-orch-'));
  dirs.push(workDir);
  const db = openDatabase(':memory:');
  const draft = createDraft(db, {
    sourceKind: 'text',
    sourceRef: 'x',
    language: 'es',
    voiceA: 'male',
    voiceB: 'female',
    mix: true,
    escaleta: scenes(opts.sceneCount ?? 3),
  });
  const job: Job = createJob(db, draft.id);
  const controller = new AbortController();
  const events: EmitInput[] = [];
  const ctx = { signal: controller.signal, workDir, emit: (e: EmitInput) => events.push(e) };

  const workflows: Array<Record<string, { class_type: string; inputs: Record<string, unknown> }>> = [];
  let t2vCalls = 0;
  let i2vCalls = 0;
  const pending = new Map<string, boolean>();
  const abortErr = (m: string) => {
    const e = new Error(m);
    e.name = 'AbortError';
    return e;
  };
  const comfy = {
    lastWaitId: null as string | null,
    interrupts: [] as Array<string | null>,
    deleteCalls: [] as string[],
    uploads: [] as string[],
    submit: async (wf: (typeof workflows)[number]) => {
      workflows.push(wf);
      const isI2V = Object.values(wf).some((n) => n.class_type === 'WanVideoImageToVideoEncode');
      const idx = isI2V ? i2vCalls++ : t2vCalls++;
      if (isI2V && opts.failI2V?.includes(idx)) throw new Error('GPU exploded');
      if (!isI2V && opts.failT2V === idx) throw new Error('out of memory');
      const id = `p${workflows.length}`;
      pending.set(id, isI2V);
      return id;
    },
    waitForCompletion: async (id: string, o?: { signal?: AbortSignal; onProgress?: (i: { value?: number; max?: number; node?: string; done?: boolean }) => void }) => {
      comfy.lastWaitId = id;
      for (const step of opts.comfySteps ?? []) o?.onProgress?.(step);
      o?.onProgress?.({ node: '7' });
      o?.onProgress?.({ done: true });
      if (o?.signal?.aborted) throw abortErr('aborted before wait');
      if (opts.abortDuringWait) {
        controller.abort();
        throw abortErr('aborted during wait');
      }
      return { '9': { images: [{ filename: `${id}.png`, subfolder: 's', type: 'output' }], gifs: [{ filename: `${id}.mp4`, subfolder: 's', type: 'output' }] } };
    },
    download: async (file: { filename: string }) => Buffer.from(`bytes:${file.filename}`),
    downloadToFile: async (file: { filename: string }, dest: string) => {
      writeFileSync(dest, Buffer.from(`bytes:${file.filename}`));
    },
    uploadImage: async (_data: Buffer, name: string) => {
      comfy.uploads.push(name);
      return `up_${name}`;
    },
    queueIds: async () => ({
      running: opts.queueRunning !== false ? [comfy.lastWaitId ?? 'p1'] : [],
      pending: opts.queuePending ? [comfy.lastWaitId ?? 'p1'] : [],
    }),
    interrupt: async (pid?: string) => {
      comfy.interrupts.push(pid ?? null);
      throw new Error('interrupt unreachable');
    },
    deletePrompt: async (pid: string) => {
      comfy.deleteCalls.push(pid);
    },
  };
  let ttsCalls = 0;
  const ttsInputs: Array<{ text: string; voice: string }> = [];
  const piper = {
    synthesize: async (o: { text: string; voice: string }) => {
      const i = ttsCalls++;
      ttsInputs.push(o);
      if (opts.failTts === i) throw new Error('piper down');
      if (opts.abortAfterTts === i) controller.abort();
      return wavOf(SCENE_SECONDS[i % SCENE_SECONDS.length]);
    },
  };
  const ffmpegCalls: string[][] = [];
  const ffmpeg = async (args: string[]) => {
    ffmpegCalls.push(args);
    writeFileSync(args[args.length - 1], `out:${basename(args[args.length - 1])}`);
  };
  const execute = createExecute({
    db,
    resolveComfy: () => comfy as unknown as ComfyClient,
    resolvePiper: () => piper as unknown as PiperClient,
    ffmpeg,
    cacheDir: opts.cacheDir,
  });
  const list = (name: string) =>
    readFileSync(join(workDir, name), 'utf8')
      .trim()
      .split('\n')
      .map((l) => basename(l.slice(6, -1)));
  return { db, draft, job, ctx, events, comfy, piper, ttsInputs, ffmpegCalls, execute, workflows, workDir, controller, list };
}

const seedsOf = (wfs: ReturnType<typeof harness>['workflows']) =>
  wfs
    .filter((w) => Object.values(w).some((n) => n.class_type === 'WanVideoEmptyEmbeds'))
    .map((w) => Object.values(w).find((n) => n.class_type === 'WanVideoSampler')!.inputs.seed);

test('runs tts, images, transitions and assemble in order and returns final.mp4', async () => {
  const h = harness();
  const { outputPath } = await h.execute(h.job, h.ctx);
  assert.equal(outputPath, join(h.workDir, 'final.mp4'));
  assert.equal(readFileSync(outputPath, 'utf8'), 'out:final.mp4');

  const stages = h.events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.deepEqual(stages, ['tts', 'images', 'transitions', 'assemble']);
  assert.ok(h.events.every((e) => e.type === 'stage' || e.type === 'progress'));
  const progress = h.events.map((e) => e.progress ?? 0);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  assert.ok(progress.every((p) => p >= 0 && p <= 1));

  assert.deepEqual(h.ttsInputs.map((t) => t.voice), ['male', 'female', 'male']);
  const wavs = [0, 1, 2].map((i) => readFileSync(join(h.workDir, 'audio', `scene_0${i}.wav`)));
  assert.deepEqual(wavs.map(wavDurationSec), SCENE_SECONDS);
});

test('reports ComfyUI sampler steps as structured substep events, not messages', async () => {
  const h = harness({ sceneCount: 1, comfySteps: [{ value: 3, max: 20 }] });
  await h.execute(h.job, h.ctx);
  const sub = h.events.filter((e) => e.substep);
  assert.ok(sub.length > 0);
  assert.deepEqual(sub[0].substep, { value: 3, max: 20 });
  assert.ok(sub.every((e) => e.type === 'progress' && e.message === undefined));
  assert.ok(h.events.every((e) => !e.message?.startsWith('comfy:')), 'node-only/done infos must not emit anything');
});

test('uses single-frame T2V stills and 33-frame I2V transitions with the next scene prompt', async () => {
  const h = harness();
  await h.execute(h.job, h.ctx);
  const frames = (w: (typeof h.workflows)[number], cls: string) =>
    Object.values(w).find((n) => n.class_type === cls)!.inputs.num_frames;
  assert.equal(h.workflows.length, 5);
  for (const w of h.workflows.slice(0, 3)) assert.equal(frames(w, 'WanVideoEmptyEmbeds'), 1);
  for (const w of h.workflows.slice(3)) assert.equal(frames(w, 'WanVideoImageToVideoEncode'), 33);
  const prompt = (w: (typeof h.workflows)[number]) =>
    Object.values(w).find((n) => n.class_type === 'WanVideoTextEncode')?.inputs.positive_prompt;
  assert.equal(prompt(h.workflows[0]), 'visual 0');
  assert.equal(prompt(h.workflows[3]), 'visual 1');
  assert.equal(prompt(h.workflows[4]), 'visual 2');
  assert.deepEqual(h.comfy.uploads.map((u) => u.replace(/^vs_[^_]+_/, '')), ['scene_00.png', 'scene_01.png', 'scene_02.png']);
});

test('varies Ken Burns per scene (not all identical) for rhythmic variety', async () => {
  const h = harness(); // 3 scenes
  await h.execute(h.job, h.ctx);
  const specs = h.ffmpegCalls
    .map((args) => args[args.indexOf('-vf') + 1])
    .filter((vf): vf is string => typeof vf === 'string' && vf.includes('zoompan'));
  assert.equal(specs.length, 3, 'one Ken Burns per scene');
  assert.ok(new Set(specs).size >= 2,
    `expected >=2 distinct Ken Burns specs for variety, got ${[...new Set(specs)].length}`);
});

test('seeds are deterministic per draft and scene', async () => {
  const a = harness();
  await a.execute(a.job, a.ctx);
  const seeds = seedsOf(a.workflows);
  assert.equal(new Set(seeds).size, 3);
  assert.ok(seeds.every((s) => Number.isInteger(s) && (s as number) >= 0));
  const again = createExecute({
    db: a.db,
    resolveComfy: () => a.comfy as unknown as ComfyClient,
    resolvePiper: () => a.piper as unknown as PiperClient,
    ffmpeg: async (args) => writeFileSync(args[args.length - 1], 'x'),
  });
  a.workflows.length = 0;
  const second = mkdtempSync(join(tmpdir(), 'vs-orch-'));
  dirs.push(second);
  await again(a.job, { ...a.ctx, workDir: second });
  assert.deepEqual(seedsOf(a.workflows), seeds);
});

test('global style injects into every visual prompt (still + transition target)', async () => {
  const h = harness(); // 3 stills + 2 transition targets
  h.job.options = { style: 'cinematic, consistent warm lighting, 35mm grain' };
  await h.execute(h.job, h.ctx);
  const all = JSON.stringify(h.workflows);
  const count = (all.match(/cinematic, consistent warm lighting, 35mm grain/g) ?? []).length;
  assert.equal(count, 5, `style applied to all 3 stills + 2 transition targets; got ${count}`);
});

test('without a style set the prompts are the raw visualPrompt (backward compat)', async () => {
  const h = harness();
  await h.execute(h.job, h.ctx);
  const all = JSON.stringify(h.workflows);
  assert.ok(!all.includes('cinematic, consistent warm lighting'), 'no injected style without the option');
});

test('assembles Ken Burns clips with the WAV durations, alternating with transitions', async () => {
  const h = harness();
  await h.execute(h.job, h.ctx);
  const kb = h.ffmpegCalls.filter((a) => a.includes('-loop'));
  assert.equal(kb.length, 3);
  assert.deepEqual(kb.map((a) => a[a.indexOf('-t') + 1]), ['0.5', '0.75', '1']);
  const isZoom = (vf: string) =>
    /zoompan=z='min\(1\+[\d.]+\*on,[\d.]+\)'/.test(vf) || /zoompan=z='max\([\d.]+-[\d.]+\*on,1\)'/.test(vf);
  assert.ok(kb.every((a) => isZoom(a[a.indexOf('-vf') + 1])), 'each Ken Burns uses a zoom-in or zoom-out spec');
  assert.ok(kb.every((a) => a[a.indexOf('-vf') + 1].includes('s=1280x720')));

  const norm = h.ffmpegCalls.filter((a) => a[1]?.includes('transitions') || a[1]?.includes('trans_'));
  assert.equal(norm.length, 2);
  assert.deepEqual(h.list('video.txt'), ['kb_00.mp4', 'tr_00.mp4', 'kb_01.mp4', 'tr_01.mp4', 'kb_02.mp4']);
  assert.deepEqual(h.list('audio.txt'), ['scene_00.wav', 'silence_00.wav', 'scene_01.wav', 'silence_01.wav', 'scene_02.wav']);

  const silence = readFileSync(join(h.workDir, 'audio', 'silence_00.wav'));
  assert.ok(Math.abs(wavDurationSec(silence) - 33 / 16) < 1 / fmt.rate);
  assert.deepEqual(parseWav(silence).format, fmt);

  const thirdLast = h.ffmpegCalls[h.ffmpegCalls.length - 3];
  assert.deepEqual(thirdLast, [
    '-i', join(h.workDir, 'video.mp4'), '-i', join(h.workDir, 'audio', 'narration.wav'),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
    join(h.workDir, 'muxed.mp4'),
  ]);

  const burn = h.ffmpegCalls[h.ffmpegCalls.length - 2];
  assert.equal(burn[1], join(h.workDir, 'muxed.mp4'));
  assert.match(burn[burn.indexOf('-vf') + 1], /^subtitles=.*subtitles\.srt/);
  assert.equal(burn[burn.length - 1], join(h.workDir, 'final.mp4'));
  assert.ok(readFileSync(join(h.workDir, 'subtitles.srt'), 'utf8').includes('narration 0'));

  const cover = h.ffmpegCalls[h.ffmpegCalls.length - 1];
  assert.equal(cover[1], join(h.workDir, 'muxed.mp4'), 'cover from the subtitle-free base (no burned subs)');
  assert.equal(cover[cover.length - 1], join(h.workDir, 'cover.jpg'));
});

test('a failed transition degrades to a hard cut and is reported', async () => {
  const h = harness({ failI2V: [0] });
  await h.execute(h.job, h.ctx);
  assert.deepEqual(h.list('video.txt'), ['kb_00.mp4', 'kb_01.mp4', 'tr_01.mp4', 'kb_02.mp4']);
  assert.deepEqual(h.list('audio.txt'), ['scene_00.wav', 'scene_01.wav', 'silence_01.wav', 'scene_02.wav']);
  const msg = h.events.find((e) => e.message)?.message;
  assert.match(msg ?? '', /transition 0 failed, using a hard cut: GPU exploded/);
  assert.equal(h.events.find((e) => e.message)?.type, 'stage');
});

test('all transitions failing still yields a hard-cut video', async () => {
  const h = harness({ failI2V: [0, 1] });
  await h.execute(h.job, h.ctx);
  assert.deepEqual(h.list('video.txt'), ['kb_00.mp4', 'kb_01.mp4', 'kb_02.mp4']);
  assert.deepEqual(h.list('audio.txt'), ['scene_00.wav', 'scene_01.wav', 'scene_02.wav']);
});

test('a single-scene draft skips transitions', async () => {
  const h = harness({ sceneCount: 1 });
  await h.execute(h.job, h.ctx);
  assert.equal(h.workflows.length, 1);
  assert.deepEqual(h.list('video.txt'), ['kb_00.mp4']);
});

test('B2: cancellation during TTS throws AbortError without touching shared ComfyUI (no prompt in flight)', async () => {
  const h = harness({ abortAfterTts: 0 });
  await assert.rejects(h.execute(h.job, h.ctx), (e: Error) => e.name === 'AbortError');
  assert.deepEqual(h.comfy.interrupts, [], 'no in-flight prompt must not trigger /interrupt on a shared server');
  assert.deepEqual(h.comfy.deleteCalls, []);
  assert.equal(h.workflows.length, 0);
  assert.equal(h.ffmpegCalls.length, 0);
});

test('B2: cancellation while the job\'s prompt is running interrupts with that prompt\'s id', async () => {
  const h = harness({ abortDuringWait: true });
  await assert.rejects(h.execute(h.job, h.ctx), (e: Error) => e.name === 'AbortError');
  assert.deepEqual(h.comfy.interrupts, ['p1'], 'interrupt must target the in-flight prompt');
  assert.deepEqual(h.comfy.deleteCalls, []);
  assert.equal(h.workflows.length, 1, 'the in-flight scene was submitted');
});

test('B2: cancellation while the prompt is only queued deletes that prompt (no global interrupt)', async () => {
  const h = harness({ abortDuringWait: true, queueRunning: false, queuePending: true });
  await assert.rejects(h.execute(h.job, h.ctx), (e: Error) => e.name === 'AbortError');
  assert.deepEqual(h.comfy.interrupts, [], 'a queued prompt must not force a global /interrupt');
  assert.deepEqual(h.comfy.deleteCalls, ['p1']);
});

test('cancellation before start throws without touching clients', async () => {
  const h = harness();
  h.controller.abort();
  await assert.rejects(h.execute(h.job, h.ctx), (e: Error) => e.name === 'AbortError');
  assert.equal(h.ttsInputs.length, 0);
});

test('TTS failure names the scene and stage', async () => {
  const h = harness({ failTts: 1 });
  await assert.rejects(h.execute(h.job, h.ctx), /tts failed for scene 2: piper down/);
});

test('T2V failure fails the whole job naming the scene and stage', async () => {
  const h = harness({ failT2V: 1 });
  await assert.rejects(h.execute(h.job, h.ctx), /images failed for scene 2: out of memory/);
});

test('fails clearly when the draft is missing or empty', async () => {
  const h = harness();
  await assert.rejects(h.execute({ ...h.job, draftId: 'nope' }, h.ctx), /Draft nope not found/);
  const empty = harness({ sceneCount: 0 });
  await assert.rejects(empty.execute(empty.job, empty.ctx), /no scenes/);
});

test('disables pingpong in every submitted workflow so clips keep numFrames / 16 seconds', async () => {
  const h = harness();
  await h.execute(h.job, h.ctx);
  assert.equal(h.workflows.length, 5);
  // Stills save via SaveImage; transitions render video (VHS_VideoCombine) — any video node must have pingpong off.
  let sawVideo = false;
  for (const w of h.workflows) {
    const combine = Object.values(w).find((n) => n.class_type === 'VHS_VideoCombine');
    if (combine) {
      sawVideo = true;
      assert.equal(combine.inputs.pingpong, false);
    }
  }
  assert.ok(sawVideo);
});

test('progress never decreases when a transition fails', async () => {
  const h = harness({ failI2V: [0, 1] });
  await h.execute(h.job, h.ctx);
  const values = h.events.filter((e) => e.progress !== undefined).map((e) => e.progress as number);
  assert.ok(values.length > 0);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `progress dropped from ${values[i - 1]} to ${values[i]} at event ${i}`);
  }
  const failure = h.events.find((e) => e.message);
  assert.ok((failure?.progress ?? 0) >= 0.55);
});

test('fails clearly when scene WAVs have different formats', async () => {
  const h = harness({ sceneCount: 2 });
  let call = 0;
  h.piper.synthesize = async () =>
    wavFromPcm(Buffer.alloc(8000), call++ === 0 ? fmt : { rate: 22050, width: 2, channels: 1 });
  await assert.rejects(
    h.execute(h.job, h.ctx),
    /scene 2.*22050 Hz.*16-bit.*1 ch.*scene 1.*16000 Hz.*16-bit.*1 ch/,
  );
  assert.equal(h.comfy.uploads.length, 0);
  assert.equal(h.workflows.length, 0);
});

test('chapters: writes a chapters.json aligned to the narration timeline', async () => {
  const h = harness();
  const res = await h.execute(h.job, h.ctx);
  assert.ok(res.chaptersPath);
  assert.ok(existsSync(res.chaptersPath));
  const chs = JSON.parse(readFileSync(res.chaptersPath, 'utf8')) as Array<{ index: number; title: string; startSec: number; durationSec: number }>;
  const scenes = h.draft.escaleta.length;
  assert.equal(chs.length, scenes);
  assert.equal(chs[0].startSec, 0);
  assert.deepEqual(chs.map((c) => c.index), Array.from({ length: scenes }, (_, i) => i));
  assert.ok(chs.every((c) => c.durationSec > 0 && Number.isFinite(c.startSec)));
  assert.ok(Array.isArray(res.chapters));
  assert.equal(res.chapters!.length, scenes);
});

test('with a cacheDir, a second run reuses TTS/stills/transitions without new client work', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'vs-cache-hit-'));
  dirs.push(cacheDir);
  const h = harness({ cacheDir });
  await h.execute(h.job, h.ctx);
  const tts1 = h.ttsInputs.length;
  const stills1 = h.workflows.filter((w) => Object.values(w).some((n) => n.class_type === 'WanVideoEmptyEmbeds')).length;
  const uploads1 = h.comfy.uploads.length;
  assert.ok(tts1 >= 3, 'run produced >= 3 TTS items');
  assert.ok(stills1 >= 3, 'run rendered >= 3 stills');
  assert.ok(uploads1 >= 3, `run uploaded the still set once (got ${uploads1})`);
  await h.execute(h.job, h.ctx);
  assert.equal(h.ttsInputs.length, tts1, 'TTS cached: no new synthesize on the 2nd run');
  assert.equal(h.workflows.filter((w) => Object.values(w).some((n) => n.class_type === 'WanVideoEmptyEmbeds')).length, stills1, 'still cached: no new T2V on the 2nd run');
  assert.equal(h.comfy.uploads.length, uploads1, 'transitions cached: no new uploads on the 2nd run');
});

test('a cache hit that vanishes between has() and copyTo() regenerates instead of failing the job', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'vs-cache-vanish-'));
  dirs.push(cacheDir);
  const h = harness({ cacheDir });
  await h.execute(h.job, h.ctx);
  const stills1 = h.workflows.filter((w) => Object.values(w).some((n) => n.class_type === 'WanVideoEmptyEmbeds')).length;
  const tts1 = h.ttsInputs.length;
  for (const f of readdirSync(cacheDir)) rmSync(join(cacheDir, f)); // entries pruned away...
  const realHas = ContentCache.prototype.has;
  ContentCache.prototype.has = () => true; // ...but has() still reported them
  try {
    const { outputPath } = await h.execute(h.job, h.ctx);
    assert.equal(readFileSync(outputPath, 'utf8'), 'out:final.mp4');
  } finally {
    ContentCache.prototype.has = realHas;
  }
  assert.ok(h.ttsInputs.length > tts1, 'TTS regenerated');
  assert.ok(h.workflows.filter((w) => Object.values(w).some((n) => n.class_type === 'WanVideoEmptyEmbeds')).length > stills1, 'stills regenerated');
});

test('an invalid WAV from TTS is never stored in the cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'vs-cache-badwav-'));
  dirs.push(cacheDir);
  const h = harness({ cacheDir, sceneCount: 1 });
  h.piper.synthesize = async () => Buffer.from('this is not a wav');
  await assert.rejects(h.execute(h.job, h.ctx));
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('cache hits do not read whole png/mp4 files into memory (copy via the cache)', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'vs-cache-copy-'));
  dirs.push(cacheDir);
  const h = harness({ cacheDir });
  await h.execute(h.job, h.ctx);
  const proto = ContentCache.prototype;
  const real = { read: proto.read, copyTo: proto.copyTo };
  const reads: string[] = [];
  let copies = 0;
  proto.read = function (this: ContentCache, k: string) {
    reads.push(k);
    return real.read.call(this, k);
  };
  proto.copyTo = function (this: ContentCache, k: string, d: string) {
    copies++;
    return real.copyTo.call(this, k, d);
  };
  try {
    await h.execute(h.job, h.ctx);
  } finally {
    proto.read = real.read;
    proto.copyTo = real.copyTo;
  }
  assert.equal(copies, 3 + 2, '3 stills + 2 transitions copied');
  assert.ok(reads.length <= 3, 'only TTS wavs go through read()');
});

// B6: when ffmpeg fails the partial output (LAST argument) inside workDir is removed best-effort.
type FailMode = 'exit' | 'abort' | 'timeout';

async function failFirstFfmpeg(mode: FailMode) {
  const h = harness({ sceneCount: 1 });
  let target = '';
  const execute = createExecute({
    db: h.db,
    resolveComfy: () => h.comfy as unknown as ComfyClient,
    resolvePiper: () => h.piper as unknown as PiperClient,
    ffmpeg: async (args) => {
      target = args[args.length - 1];
      writeFileSync(target, 'partial');
      if (mode === 'abort') h.controller.abort();
      throw new Error(mode === 'timeout' ? 'ffmpeg stalled: no output for 20ms' : mode === 'abort' ? 'ffmpeg aborted' : 'ffmpeg exited with code 1');
    },
  });
  const err = await execute(h.job, h.ctx).then(
    () => undefined,
    (e: Error) => e,
  );
  return { err, target, workDir: h.workDir };
}

for (const mode of ['exit', 'timeout'] as const) { // 'timeout' = the stall watchdog fired
  test(`ffmpeg ${mode} failure removes the partial output inside workDir and surfaces the original error`, async () => {
    const { err, target, workDir } = await failFirstFfmpeg(mode);
    assert.ok(err);
    assert.match(err.message, mode === 'timeout' ? /stalled: no output for 20ms/ : /exited with code 1/);
    assert.ok(target.startsWith(workDir));
    assert.equal(existsSync(target), false);
  });
}

test('ffmpeg abort removes the partial output and the job ends as an abort', async () => {
  const { err, target } = await failFirstFfmpeg('abort');
  assert.ok(err);
  assert.equal(err.name, 'AbortError');
  assert.equal(existsSync(target), false);
});

test('removePartialFfmpegOutput only removes files inside workDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'vs-clean-'));
  dirs.push(root);
  const workDir = join(root, 'job');
  const sibling = join(root, 'job-sibling');
  mkdirSync(workDir);
  mkdirSync(sibling);
  const inside = join(workDir, 'a.mp4');
  const outside = join(sibling, 'b.mp4');
  const optionLike = join(workDir, '-y');
  for (const f of [inside, outside, optionLike]) writeFileSync(f, 'x');

  removePartialFfmpegOutput(['-i', 'in', outside], workDir);
  assert.equal(existsSync(outside), true, 'sibling dir sharing the prefix is kept');
  removePartialFfmpegOutput(['-i', 'in', '-y'], workDir);
  removePartialFfmpegOutput(['-i', 'in', ''], workDir);
  removePartialFfmpegOutput([], workDir);
  assert.equal(existsSync(optionLike), true, 'option-looking argument is never treated as output');
  removePartialFfmpegOutput(['-i', 'in', join(workDir, 'missing.mp4')], workDir);
  removePartialFfmpegOutput(['-i', 'in', inside], workDir);
  assert.equal(existsSync(inside), false);
});

test('every ffmpeg args builder ends with the output path (contract used by the cleanup)', () => {
  const out = '/work/out.mp4';
  const cases: Record<string, string[]> = {
    kenBurnsArgs: kenBurnsArgs({ image: 'i.png', durationSec: 2, out }),
    xfadeArgs: xfadeArgs({ clips: ['a', 'b'], durationsSec: [3, 3], transitionSec: 1, out }),
    concatArgs: concatArgs({ listFile: 'l.txt', out }),
    muxAudioArgs: muxAudioArgs({ video: 'v', audio: 'a', out }),
    musicMixArgs: musicMixArgs({ video: 'v', audio: 'a', music: 'm', out }),
    extractFrameArgs: extractFrameArgs({ video: 'v', out }),
    burnSubtitlesArgs: burnSubtitlesArgs({ input: 'v', srt: 's.srt', out }),
    burnSubtitlesStyled: burnSubtitlesArgs({ input: 'v', srt: 's.srt', out, style: 'Fontsize=20' }),
    verticalCropArgs: verticalCropArgs({ input: 'v', out }),
    coverArgs: coverArgs({ input: 'v', atSec: 1, out }),
    normalizeClipArgs: normalizeClipArgs({ input: 'v', out }),
  };
  for (const [name, args] of Object.entries(cases)) {
    assert.equal(args[args.length - 1], out, `${name} must end with the output path`);
  }
});
