import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ComfyClient, ProgressInfo } from '../clients/comfy';
import { extractVideoOutput, extractOutputFile } from '../clients/comfy';
import { logger } from '../lib/logger';
import type { PiperClient } from '../clients/piper';
import { buildI2VWorkflow, buildT2VWorkflow, DEFAULTS } from '../comfy/workflows';
import type { EmitInput, ExecuteFn, Job, JobContext } from '../jobs/types';
import {
  buildConcatList,
  concatArgs,
  kenBurnsArgs,
  musicMixArgs,
  muxAudioArgs,
  burnSubtitlesArgs,
  verticalCropArgs,
  coverArgs,
  normalizeClipArgs,
  runFfmpeg,
} from '../media/ffmpeg';
import { parseWav, type PcmFormat, wavDurationSec, wavSilence } from '../media/wav';
import { getDraft } from './draftRepository';
import { buildSrt, sceneCues } from './subtitles';
import { DEFAULT_MUSIC_VOLUME, type Escaleta } from './types';
import { ContentCache, TTS_CACHE_VERSION, WORKFLOW_VERSION } from './contentCache';
import { buildChapters, type Chapter } from './chapters';

export type FfmpegFn = (args: string[], opts?: { signal?: AbortSignal }) => Promise<void>;

export interface OrchestratorDeps {
  db: DatabaseSync;
  resolveComfy: () => ComfyClient;
  resolvePiper: () => PiperClient;
  ffmpeg?: FfmpegFn;
  /** Frames rendered per I2V transition. Default 33. */
  framesPerTransition?: number;
  /** Directory for the content cache of rendered artifacts; off when omitted. App default: data/cache. */
  cacheDir?: string;
}

export type Stage = 'tts' | 'images' | 'transitions' | 'assemble';

const RANGES: Record<Stage, [number, number]> = {
  tts: [0, 0.15],
  images: [0.15, 0.55],
  transitions: [0.55, 0.85],
  assemble: [0.85, 1],
};
// libass force_style for the 9:16 (720x1280) vertical variant: sized to the frame, centered,
// with margins that keep text inside the portrait frame (vs. the default 16:9 sizing).
const VERTICAL_SUB_STYLE = 'PlayResX=720,PlayResY=1280,FontSize=13,Alignment=2,MarginV=60,Outline=1';
const pad = (i: number) => String(i).padStart(2, '0');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sameFormat = (a: PcmFormat, b: PcmFormat) => a.rate === b.rate && a.width === b.width && a.channels === b.channels;
const describeFormat = (f: PcmFormat) => `${f.rate} Hz, ${f.width * 8}-bit, ${f.channels} ch`;

function seedFor(draftId: string, sceneIndex: number): number {
  return createHash('sha256').update(`${draftId}:${sceneIndex}`).digest().readUInt32BE(0);
}

// doc §4 ritmo: vary the Ken Burns per scene (zoom magnitude + in/out direction) so consecutive
// scenes don't all push in the same way. Deterministic per (visualPrompt, index) → stable re-render.
function kenBurnsSpec(visualPrompt: string, index: number): { zoomTo: number; direction: 'zoom-in' | 'zoom-out' } {
  const h = seedFor(`kb:${visualPrompt}`, index);
  const direction: 'zoom-in' | 'zoom-out' = h % 2 === 0 ? 'zoom-in' : 'zoom-out';
  const zoomTo = 1.08 + (h % 5) * 0.02; // 1.08 .. 1.16 in steps of 0.02
  return { zoomTo, direction };
}

// doc §1: a global style (lighting/palette/realism) applied to every scene's visual prompt for
// consistency across the video — applied at render time and included in the cache key.
function stylePrompt(style: string | undefined, visualPrompt: string): string {
  const s = (style ?? '').trim();
  return s ? `${s}. ${visualPrompt}` : visualPrompt;
}

function abortError(): Error {
  const e = new Error('Job cancelled');
  e.name = 'AbortError';
  return e;
}

// Output contracts for each stage. Named (and exported via Shared) so a content cache and a
// resume layer can treat a stage as a reusable, keyable/skippable unit of work.
interface TTSResult {
  wavPaths: string[];
  durations: number[];
  format: PcmFormat;
}
interface StillsResult {
  pngs: string[];
}
type TransitionMap = Array<string | undefined>;
interface AssembleResult {
  outputPath: string;
  chaptersPath: string;
  chapters: Chapter[];
}

interface Shared {
  job: Job;
  signal: AbortSignal;
  /**
   * B2: the prompt id most recently submitted to ComfyUI by this job (updated on every
   * submit). Used to scope cancellation: on abort the orchestrator consults /queue and only
   * acts (interrupt / delete) if THIS job's prompt is the one running or queued.
   */
  inflight: { promptId: string | null };
  workDir: string;
  n: number;
  escaleta: Escaleta;
  comfy: ComfyClient;
  piper: PiperClient;
  ffmpeg: FfmpegFn;
  frames: number;
  cache?: ContentCache;
  audioDir: string;
  stillsDir: string;
  transDir: string;
  clipsDir: string;
  prefix: string;
  guard: () => void;
  run: (args: string[]) => Promise<void>;
  fail: (stage: Stage, what: string, e: unknown) => never;
  emit: (partial: EmitInput) => void;
  begin: (stage: Stage, msg?: string) => void;
  step: (stage: Stage, done: number, total: number) => void;
  comfyStep: (stage: Stage, info: ProgressInfo) => void;
  sceneFile: (dir: string, name: string, i: number, ext: string) => string;
}

// Stage 1 — TTS per scene. All scene WAVs must share one format; a drift is a hard error.
// Cache key: (TTS_CACHE_VERSION, narration, voice).
async function executeTTS(s: Shared): Promise<TTSResult> {
  const { n, escaleta, piper, guard, fail, sceneFile, audioDir } = s;
  const wavPaths: string[] = [];
  const durations: number[] = [];
  let format: PcmFormat | undefined;
  s.begin('tts');
  for (let i = 0; i < n; i++) {
    guard();
    const key = s.cache?.key(TTS_CACHE_VERSION, escaleta[i].narration, escaleta[i].voice);
    let wav: Buffer;
    if (s.cache && key && s.cache.has(key)) {
      wav = s.cache.read(key);
    } else {
      try {
        wav = await piper.synthesize({ text: escaleta[i].narration, voice: escaleta[i].voice });
      } catch (e) {
        return fail('tts', `scene ${i + 1}`, e);
      }
      if (s.cache && key) s.cache.store(key, wav);
    }
    durations.push(wavDurationSec(wav));
    const sceneFormat = parseWav(wav).format;
    format ??= sceneFormat;
    if (!sameFormat(format, sceneFormat)) {
      throw new Error(
        `tts failed: scene ${i + 1} is ${describeFormat(sceneFormat)} but scene 1 is ${describeFormat(format)}; all scenes must share one WAV format`,
      );
    }
    const path = sceneFile(audioDir, 'scene', i, 'wav');
    writeFileSync(path, wav);
    wavPaths.push(path);
    s.step('tts', i + 1, n);
  }
  if (!format) throw new Error('tts failed: no scene produced a WAV');
  return { wavPaths, durations, format };
}

// Stage 2 — single-frame T2V still per scene (a 1-frame ComfyUI video, then ffmpeg -> PNG).
// Cache key: (WORKFLOW_VERSION, 't2v', visualPrompt, seed, width, height, 1frame).
async function executeStills(s: Shared): Promise<StillsResult> {
  const { n, escaleta, comfy, guard, fail, run, sceneFile, stillsDir, prefix } = s;
  const pngs: string[] = [];
  s.begin('images');
  for (let i = 0; i < n; i++) {
    guard();
    const seed = seedFor(s.job.draftId, i);
    const png = sceneFile(stillsDir, 'scene', i, 'png');
    const prompt = stylePrompt(s.job.options?.style, escaleta[i].visualPrompt);
    const key = s.cache?.key(WORKFLOW_VERSION, 't2v', prompt, seed, DEFAULTS.width, DEFAULTS.height, 1, s.job.options?.useLightx2v);
    if (s.cache && key && s.cache.has(key)) {
      writeFileSync(png, s.cache.read(key));
    } else {
      try {
        const id = await comfy.submit(
          buildT2VWorkflow({
            prompt,
            seed,
            numFrames: 1,
            pingpong: false,
            saveImage: true,
            filenamePrefix: `${prefix}_still_${pad(i)}`,
            useLightx2v: s.job.options?.useLightx2v,
          }),
        );
        s.inflight.promptId = id;
        const outputs = await comfy.waitForCompletion(id, { onProgress: (info) => s.comfyStep('images', info), signal: s.signal });
        const file = extractOutputFile(outputs);
        if (!file) throw new Error('ComfyUI returned no image output');
        writeFileSync(png, await comfy.download(file));
        if (s.cache && key) s.cache.store(key, readFileSync(png));
      } catch (e) {
        return fail('images', `scene ${i + 1}`, e);
      }
    }
    pngs.push(png);
    s.step('images', i + 1, n);
  }
  return { pngs };
}

// Stage 3 — I2V transitions between consecutive stills. A failed transition degrades to a hard
// cut (an undefined slot) with a stage-event message. Cache key:
// (WORKFLOW_VERSION, 'i2v', startPrompt, targetPrompt, seed, frames).
async function executeTransitions(s: Shared, stills: StillsResult): Promise<TransitionMap> {
  const { n, escaleta, comfy, guard, sceneFile, transDir, prefix, frames } = s;
  const transitions: TransitionMap = [];
  s.begin('transitions');
  // Each still is uploaded to ComfyUI at most once per run (transitions share a still
  // as end/i+1 and start/i+2); we just reference the name on subsequent transitions.
  const uploaded = new Set<string>();
  const uploadStill = async (i: number): Promise<string> => {
    const name = `${prefix}_scene_${pad(i)}.png`;
    if (!uploaded.has(name)) {
      await comfy.uploadImage(readFileSync(stills.pngs[i]), name);
      uploaded.add(name);
    }
    return name;
  };
  for (let i = 0; i < n - 1; i++) {
    guard();
    const seed = seedFor(s.job.draftId, 1000 + i);
    const key = s.cache?.key(WORKFLOW_VERSION, 'i2v', stylePrompt(s.job.options?.style, escaleta[i].visualPrompt), stylePrompt(s.job.options?.style, escaleta[i + 1].visualPrompt), seed, frames, s.job.options?.useLightx2v);
    if (s.cache && key && s.cache.has(key)) {
      const out = sceneFile(transDir, 'trans', i, 'mp4');
      writeFileSync(out, s.cache.read(key));
      transitions.push(out);
    } else {
      try {
        const start = await uploadStill(i);
        const end = await uploadStill(i + 1);
        const id = await comfy.submit(
          buildI2VWorkflow({
            startImage: start,
            endImage: end,
            prompt: stylePrompt(s.job.options?.style, escaleta[i + 1].visualPrompt),
            seed,
            useLightx2v: s.job.options?.useLightx2v,
            numFrames: frames,
            pingpong: false,
            filenamePrefix: `${prefix}_trans_${pad(i)}`,
          }),
        );
        s.inflight.promptId = id;
        const outputs = await comfy.waitForCompletion(id, { onProgress: (info) => s.comfyStep('transitions', info), signal: s.signal });
        const file = extractVideoOutput(outputs);
        if (!file) throw new Error('ComfyUI returned no video output');
        const out = sceneFile(transDir, 'trans', i, 'mp4');
        await comfy.downloadToFile(file, out);
        transitions.push(out);
        if (s.cache && key) s.cache.store(key, readFileSync(out));
      } catch (e) {
        guard();
        transitions.push(undefined);
        s.begin('transitions', `transition ${i} failed, using a hard cut: ${message(e)}`);
      }
    }
    s.step('transitions', i + 1, n - 1);
  }
  return transitions;
}

// Stage 4 — assemble. Ken Burns per still -> concat with transitions (one silence per cut) ->
// mux (optional music, ducked) -> burn subtitles (if on) -> 9:16 crop (if on) -> cover frame.
// The four music x subtitle branches are kept as-is in this pass; deduplicating them is the
// separate "final del montaje" improvement and depends on the vertical/subtitle bug fix.
// Not cached: it is cheap ffmpeg over already-cached inputs.
async function executeAssemble(s: Shared, tts: TTSResult, stills: StillsResult, transitions: TransitionMap): Promise<AssembleResult> {
  const { n, escaleta, job, guard, run, sceneFile, clipsDir, audioDir, workDir, frames } = s;
  const { wavPaths, durations, format } = tts;
  const pngs = stills.pngs;
  const videoParts: string[] = [];
  const audioParts: string[] = [];
  // ComfyUI renders at DEFAULTS.fps (16), so a transition lasts numFrames / 16 seconds.
  const transitionSec = frames / DEFAULTS.fps;

  s.begin('assemble');
  for (let i = 0; i < n; i++) {
    guard();
    const kb = sceneFile(clipsDir, 'kb', i, 'mp4');
    const spec = kenBurnsSpec(escaleta[i].visualPrompt, i);
    await run(kenBurnsArgs({ image: pngs[i], durationSec: durations[i], out: kb, zoomTo: spec.zoomTo, direction: spec.direction }));
    videoParts.push(kb);
    audioParts.push(wavPaths[i]);
    const trans = transitions[i];
    if (i < n - 1 && trans) {
      const tr = sceneFile(clipsDir, 'tr', i, 'mp4');
      await run(normalizeClipArgs({ input: trans, out: tr }));
      videoParts.push(tr);
      const silence = sceneFile(audioDir, 'silence', i, 'wav');
      writeFileSync(silence, wavSilence(transitionSec, format));
      audioParts.push(silence);
    }
    s.step('assemble', i + 1, n);
  }

  const videoList = join(workDir, 'video.txt');
  const audioList = join(workDir, 'audio.txt');
  const video = join(workDir, 'video.mp4');
  const narration = join(audioDir, 'narration.wav');
  const finalPath = join(workDir, 'final.mp4');
  writeFileSync(videoList, buildConcatList(videoParts));
  writeFileSync(audioList, buildConcatList(audioParts));
  await run(concatArgs({ listFile: videoList, out: video }));
  await run(concatArgs({ listFile: audioList, out: narration }));

  const subtitlesOn = job.options?.subtitles !== false;
  const baseName = subtitlesOn ? 'muxed.mp4' : 'final.mp4';
  const basePath = join(workDir, baseName);
  const coverPath = join(workDir, 'cover.jpg');
  const totalSec = durations.reduce((a, b) => a + b, 0) + transitions.filter((t) => t !== undefined).length * transitionSec;

  // Chapter markers aligned to the muxed timeline (narration + short I2V transitions).
  const chaptersPath = join(workDir, 'chapters.json');
  const chapters = buildChapters(escaleta, durations, transitionSec, (i) => i < n - 1 && Boolean(transitions[i]));
  writeFileSync(chaptersPath, JSON.stringify(chapters, null, 2));

  const music = job.options?.music;
  if (music && !existsSync(music)) throw new Error(`Music file not found: ${music}`);

  // A) Subtitle-free base with the narration (and optional ducked music).
  if (music) {
    await run(musicMixArgs({ video, audio: narration, music, musicVolume: job.options?.musicVolume ?? DEFAULT_MUSIC_VOLUME, out: basePath }));
  } else {
    await run(muxAudioArgs({ video, audio: narration, out: basePath }));
  }

  // B) 16:9 master: subtitles burned onto the base (if requested). Always the default deliverable.
  let deliverable = basePath;
  if (subtitlesOn) {
    const srtPath = join(workDir, 'subtitles.srt');
    const present = durations.slice(0, -1).map((_, i) => transitions[i] !== undefined);
    writeFileSync(srtPath, buildSrt(sceneCues(durations, transitionSec, escaleta.map((sc) => sc.narration), present)));
    await run(burnSubtitlesArgs({ input: basePath, srt: srtPath, out: finalPath }));
    deliverable = finalPath;
  }

  // C) Vertical 9:16 variant: crop the SUBTITLE-FREE base first, then (only if subtitles are
  //    on) burn them in a 9:16-appropriate style. The crop therefore never clips the subtitles
  //    because they are applied to the already-cropped portrait frame. (fix: vertical subs)
  if (job.options?.vertical) {
    const finalV = join(workDir, 'final_v.mp4');
    if (subtitlesOn) {
      const baseV = join(workDir, 'base_v.mp4');
      await run(verticalCropArgs({ input: basePath, out: baseV }));
      await run(burnSubtitlesArgs({ input: baseV, srt: join(workDir, 'subtitles.srt'), out: finalV, style: VERTICAL_SUB_STYLE }));
    } else {
      await run(verticalCropArgs({ input: basePath, out: finalV }));
    }
  }

  // D) Cover frame at the film midpoint — taken from the subtitle-free base so it never shows
  //    burned subtitles. (Choosing a specific still is a separate improvement.)
  await run(coverArgs({ input: basePath, atSec: totalSec / 2, out: coverPath }));

  return { outputPath: deliverable, chaptersPath, chapters };
}

export function createExecute(deps: OrchestratorDeps): ExecuteFn {
  const ffmpeg: FfmpegFn = deps.ffmpeg ?? runFfmpeg;
  const frames = deps.framesPerTransition ?? 33;
  const cache = deps.cacheDir ? new ContentCache(deps.cacheDir) : undefined;

  return async (job, ctx: JobContext) => {
    const { signal, workDir, emit } = ctx;
    const log = logger.child('pipeline');
    const jobMeta = { jobId: job.id, draftId: job.draftId };
    if (signal.aborted) throw abortError();
    const draft = getDraft(deps.db, job.draftId);
    if (!draft) throw new Error(`Draft ${job.draftId} not found`);
    const { escaleta } = draft;
    if (escaleta.length === 0) throw new Error(`Draft ${draft.id} has no scenes`);

    const comfy = deps.resolveComfy();
    const piper = deps.resolvePiper();

    // B2: ComfyUI is a SHARED server — /interrupt is global there (core 0.28 ignores the
    // prompt_id body), so blindly calling it on cancel kills other users' jobs. Strategy:
    // check /queue first; only interrupt if THIS job's own prompt is the one running (making
    // the global interrupt safe), best-effort DELETE /prompt/{id} if it is still queued, and
    // touch nothing when the job is not in a ComfyUI phase (tts/ffmpeg, or not started).
    const inflight: { promptId: string | null } = { promptId: null };
    let comfyAbort: Promise<void> | null = null;
    const cancelComfy = (): Promise<void> => {
      if (!comfyAbort) {
        comfyAbort = (async () => {
          const id = inflight.promptId;
          if (!id) return; // job never reached ComfyUI → must not touch the shared server
          try {
            const { running, pending } = await comfy.queueIds();
            if (running.includes(id)) {
              await comfy.interrupt(id); // our prompt is the one running → global interrupt is safe
            } else if (pending.includes(id)) {
              await comfy.deletePrompt(id); // 0.28 core: 405 → caught below; newer cores: removed
            }
          } catch {
            /* best-effort cancel: the job already fails with AbortError */
          }
        })();
      }
      return comfyAbort;
    };
    const onAbort = (): void => {
      void cancelComfy();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let emitted = 0;
    const advance = (value: number) => (emitted = Math.max(emitted, value));
    const guard = () => {
      if (!signal.aborted) return;
      void cancelComfy();
      throw abortError();
    };
    const fail = (_stage: Stage, what: string, e: unknown): never => {
      guard();
      throw new Error(`${_stage} failed for ${what}: ${message(e)}`);
    };
    const begin = (stage: Stage, msg?: string) => emit({ type: 'stage', stage, progress: advance(RANGES[stage][0]), ...(msg ? { message: msg } : {}) });
    const step = (stage: Stage, done: number, total: number) => {
      const [lo, hi] = RANGES[stage];
      emit({ type: 'progress', stage, progress: advance(lo + ((hi - lo) * done) / total) });
    };
    const comfyStep = (stage: Stage, info: ProgressInfo): void => {
      if (info.done) return;
      const text =
        typeof info.max === 'number' && info.max > 0
          ? `comfy: paso ${info.value ?? 0}/${info.max}`
          : info.node
            ? `comfy: nodo ${info.node}`
            : undefined;
      if (text) emit({ type: 'progress', stage, progress: emitted, message: text });
    };
    const run = async (args: string[]) => {
      guard();
      try {
        await ffmpeg(args, { signal });
      } catch (e) {
        guard();
        throw e;
      }
    };

    const audioDir = join(workDir, 'audio');
    const stillsDir = join(workDir, 'stills');
    const transDir = join(workDir, 'transitions');
    const clipsDir = join(workDir, 'clips');
    for (const d of [audioDir, stillsDir, transDir, clipsDir]) mkdirSync(d, { recursive: true });

    const shared: Shared = {
      job,
      signal,
      inflight,
      workDir,
      n: escaleta.length,
      escaleta,
      comfy,
      piper,
      ffmpeg,
      frames,
      cache,
      audioDir,
      stillsDir,
      transDir,
      clipsDir,
      prefix: `vs_${draft.id.slice(0, 8)}`,
      guard,
      run,
      fail,
      emit,
      begin,
      step,
      comfyStep,
      sceneFile: (dir, name, i, ext) => join(dir, `${name}_${pad(i)}.${ext}`),
    };

    try {
      // Each pipeline stage is timed and logged so a failure names the step, not just the symptom.
      const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
        const t0 = Date.now();
        log.info('stage start', { stage, ...jobMeta });
        try {
          const result = await fn();
          log.info('stage done', { stage, ms: Date.now() - t0, ...jobMeta });
          return result;
        } catch (e) {
          log.error('stage failed', { stage, ms: Date.now() - t0, ...jobMeta, err: e });
          throw e;
        }
      };
      const tts = await timed('tts', () => executeTTS(shared));
      const stills = await timed('stills', () => executeStills(shared));
      const transitions = await timed('transitions', () => executeTransitions(shared, stills));
      return await timed('assemble', () => executeAssemble(shared, tts, stills, transitions));
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (comfyAbort) await comfyAbort;
    }
  };
}
