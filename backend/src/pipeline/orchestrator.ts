import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ComfyClient } from '../clients/comfy';
import { extractVideoOutput } from '../clients/comfy';
import type { PiperClient } from '../clients/piper';
import { buildI2VWorkflow, buildT2VWorkflow, DEFAULTS } from '../comfy/workflows';
import type { EmitInput, ExecuteFn, Job, JobContext } from '../jobs/types';
import {
  buildConcatList,
  concatArgs,
  extractFrameArgs,
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

export type FfmpegFn = (args: string[], opts?: { signal?: AbortSignal }) => Promise<void>;

export interface OrchestratorDeps {
  db: DatabaseSync;
  resolveComfy: () => ComfyClient;
  resolvePiper: () => PiperClient;
  ffmpeg?: FfmpegFn;
  /** Frames rendered per I2V transition. Default 33. */
  framesPerTransition?: number;
}

export type Stage = 'tts' | 'images' | 'transitions' | 'assemble';

const RANGES: Record<Stage, [number, number]> = {
  tts: [0, 0.15],
  images: [0.15, 0.55],
  transitions: [0.55, 0.85],
  assemble: [0.85, 1],
};
const KEN_BURNS_ZOOM = 1.08;
const pad = (i: number) => String(i).padStart(2, '0');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class MixedWavFormatError extends Error {}
const sameFormat = (a: PcmFormat, b: PcmFormat) => a.rate === b.rate && a.width === b.width && a.channels === b.channels;
const describeFormat = (f: PcmFormat) => `${f.rate} Hz, ${f.width * 8}-bit, ${f.channels} ch`;

function seedFor(draftId: string, sceneIndex: number): number {
  return createHash('sha256').update(`${draftId}:${sceneIndex}`).digest().readUInt32BE(0);
}

function abortError(): Error {
  const e = new Error('Job cancelled');
  e.name = 'AbortError';
  return e;
}

// Output contracts for each stage. Named so a content-cache and a resume layer (both on the roadmap)
// can index and skip a stage by keying on its inputs rather than re-running the whole job.
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
}

interface Shared {
  job: Job;
  signal: AbortSignal;
  workDir: string;
  n: number;
  escaleta: Escaleta;
  comfy: ComfyClient;
  piper: PiperClient;
  ffmpeg: FfmpegFn;
  frames: number;
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
  sceneFile: (dir: string, name: string, i: number, ext: string) => string;
}

// Stage 1 — TTS per scene. All scene WAVs must share one format; a drift is a hard error.
async function executeTTS(s: Shared): Promise<TTSResult> {
  const { n, escaleta, piper, guard, fail, run, sceneFile, audioDir } = s;
  const wavPaths: string[] = [];
  const durations: number[] = [];
  let format: PcmFormat | undefined;
  s.begin('tts');
  for (let i = 0; i < n; i++) {
    guard();
    let wav: Buffer;
    try {
      wav = await piper.synthesize({ text: escaleta[i].narration, voice: escaleta[i].voice });
      durations.push(wavDurationSec(wav));
      const sceneFormat = parseWav(wav).format;
      format ??= sceneFormat;
      if (!sameFormat(format, sceneFormat)) {
        throw new MixedWavFormatError(
          `scene ${i + 1} is ${describeFormat(sceneFormat)} but scene 1 is ${describeFormat(format)}; all scenes must share one WAV format`,
        );
      }
    } catch (e) {
      if (e instanceof MixedWavFormatError) throw new Error(`tts failed: ${e.message}`);
      return fail('tts', `scene ${i + 1}`, e);
    }
    const path = sceneFile(audioDir, 'scene', i, 'wav');
    writeFileSync(path, wav);
    wavPaths.push(path);
    s.step('tts', i + 1, n);
  }
  return { wavPaths, durations, format: format as PcmFormat };
}

// Stage 2 — single-frame T2V still per scene (a 1-frame ComfyUI video, then ffmpeg -> PNG).
async function executeStills(s: Shared): Promise<StillsResult> {
  const { n, escaleta, comfy, guard, fail, run, sceneFile, stillsDir, prefix } = s;
  const pngs: string[] = [];
  s.begin('images');
  for (let i = 0; i < n; i++) {
    guard();
    try {
      const id = await comfy.submit(
        buildT2VWorkflow({
          prompt: escaleta[i].visualPrompt,
          seed: seedFor(s.job.draftId, i),
          numFrames: 1,
          pingpong: false,
          filenamePrefix: `${prefix}_still_${pad(i)}`,
        }),
      );
      const file = extractVideoOutput(await comfy.waitForCompletion(id));
      if (!file) throw new Error('ComfyUI returned no video output');
      const mp4 = sceneFile(stillsDir, 'scene', i, 'mp4');
      writeFileSync(mp4, await comfy.download(file));
      const png = sceneFile(stillsDir, 'scene', i, 'png');
      await run(extractFrameArgs({ video: mp4, out: png }));
      pngs.push(png);
    } catch (e) {
      return fail('images', `scene ${i + 1}`, e);
    }
    s.step('images', i + 1, n);
  }
  return { pngs };
}

// Stage 3 — I2V transitions between consecutive stills. A failed transition degrades to a hard
// cut (an undefined slot) with a stage-event message; the job still completes with a hard cut there.
async function executeTransitions(s: Shared, stills: StillsResult): Promise<TransitionMap> {
  const { n, escaleta, comfy, guard, run, sceneFile, transDir, prefix, frames } = s;
  const transitions: TransitionMap = [];
  s.begin('transitions');
  for (let i = 0; i < n - 1; i++) {
    guard();
    try {
      const start = await comfy.uploadImage(readFileSync(stills.pngs[i]), `${prefix}_scene_${pad(i)}.png`);
      const end = await comfy.uploadImage(readFileSync(stills.pngs[i + 1]), `${prefix}_scene_${pad(i + 1)}.png`);
      const id = await comfy.submit(
        buildI2VWorkflow({
          startImage: start,
          endImage: end,
          prompt: escaleta[i + 1].visualPrompt,
          seed: seedFor(s.job.draftId, 1000 + i),
          numFrames: frames,
          pingpong: false,
          filenamePrefix: `${prefix}_trans_${pad(i)}`,
        }),
      );
      const file = extractVideoOutput(await comfy.waitForCompletion(id));
      if (!file) throw new Error('ComfyUI returned no video output');
      const out = sceneFile(transDir, 'trans', i, 'mp4');
      writeFileSync(out, await comfy.download(file));
      transitions.push(out);
    } catch (e) {
      guard();
      transitions.push(undefined);
      s.begin('transitions', `transition ${i} failed, using a hard cut: ${message(e)}`);
    }
    s.step('transitions', i + 1, n - 1);
  }
  return transitions;
}

// Stage 4 — assemble. Ken Burns per still -> concat with transitions (one silence per cut) ->
// mux (optional music, ducked) -> burn subtitles (if on) -> 9:16 crop (if on) -> cover frame.
// The four music x subtitle branches are kept as-is in this pass; deduplicating them is the
// separate "final del montaje" improvement and depends on the vertical/subtitle bug fix.
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
    await run(kenBurnsArgs({ image: pngs[i], durationSec: durations[i], out: kb, zoomTo: KEN_BURNS_ZOOM }));
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
  if (subtitlesOn) {
    const srtPath = join(workDir, 'subtitles.srt');
    const present = durations.slice(0, -1).map((_, i) => transitions[i] !== undefined);
    writeFileSync(srtPath, buildSrt(sceneCues(durations, transitionSec, escaleta.map((sc) => sc.narration), present)));
    if (job.options?.music) {
      const music = job.options.music;
      if (!existsSync(music)) throw new Error(`Music file not found: ${music}`);
      const muxed = join(workDir, 'muxed.mp4');
      await run(musicMixArgs({ video, audio: narration, music, musicVolume: job.options.musicVolume ?? DEFAULT_MUSIC_VOLUME, out: muxed }));
      await run(burnSubtitlesArgs({ input: muxed, srt: srtPath, out: finalPath }));
    } else {
      const muxed = join(workDir, 'muxed.mp4');
      await run(muxAudioArgs({ video, audio: narration, out: muxed }));
      await run(burnSubtitlesArgs({ input: muxed, srt: srtPath, out: finalPath }));
    }
  } else if (job.options?.music) {
    const music = job.options.music;
    if (!existsSync(music)) throw new Error(`Music file not found: ${music}`);
    await run(musicMixArgs({ video, audio: narration, music, musicVolume: job.options.musicVolume ?? DEFAULT_MUSIC_VOLUME, out: finalPath }));
  } else {
    await run(muxAudioArgs({ video, audio: narration, out: finalPath }));
  }

  // E3: optional 9:16 crop of the final film, and always a cover frame at the midpoint.
  const totalSec = durations.reduce((a, b) => a + b, 0) + transitions.filter((t) => t !== undefined).length * transitionSec;
  if (job.options?.vertical) {
    await run(verticalCropArgs({ input: finalPath, out: join(workDir, 'final_v.mp4') }));
  }
  await run(coverArgs({ input: finalPath, atSec: totalSec / 2, out: join(workDir, 'cover.jpg') }));
  return { outputPath: finalPath };
}

export function createExecute(deps: OrchestratorDeps): ExecuteFn {
  const ffmpeg: FfmpegFn = deps.ffmpeg ?? runFfmpeg;
  const frames = deps.framesPerTransition ?? 33;

  return async (job, ctx: JobContext) => {
    const { signal, workDir, emit } = ctx;
    if (signal.aborted) throw abortError();
    const draft = getDraft(deps.db, job.draftId);
    if (!draft) throw new Error(`Draft ${job.draftId} not found`);
    const { escaleta } = draft;
    if (escaleta.length === 0) throw new Error(`Draft ${draft.id} has no scenes`);

    const comfy = deps.resolveComfy();
    const piper = deps.resolvePiper();

    let interrupted = false;
    const interruptOnce = () => {
      if (interrupted) return;
      interrupted = true;
      comfy.interrupt().catch(() => {});
    };
    signal.addEventListener('abort', interruptOnce, { once: true });

    let emitted = 0;
    const advance = (value: number) => (emitted = Math.max(emitted, value));
    const guard = () => {
      if (!signal.aborted) return;
      interruptOnce();
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
      workDir,
      n: escaleta.length,
      escaleta,
      comfy,
      piper,
      ffmpeg,
      frames,
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
      sceneFile: (dir, name, i, ext) => join(dir, `${name}_${pad(i)}.${ext}`),
    };

    try {
      const tts = await executeTTS(shared);
      const stills = await executeStills(shared);
      const transitions = await executeTransitions(shared, stills);
      return await executeAssemble(shared, tts, stills, transitions);
    } finally {
      signal.removeEventListener('abort', interruptOnce);
    }
  };
}
