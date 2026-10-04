import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ComfyClient } from '../clients/comfy';
import { extractVideoOutput } from '../clients/comfy';
import type { PiperClient } from '../clients/piper';
import { buildI2VWorkflow, buildT2VWorkflow, DEFAULTS } from '../comfy/workflows';
import type { ExecuteFn, JobContext } from '../jobs/types';
import {
  buildConcatList,
  concatArgs,
  extractFrameArgs,
  kenBurnsArgs,
  muxAudioArgs,
  normalizeClipArgs,
  runFfmpeg,
} from '../media/ffmpeg';
import { parseWav, wavDurationSec, wavSilence } from '../media/wav';
import { getDraft } from './draftRepository';

export type FfmpegFn = (args: string[], opts?: { signal?: AbortSignal }) => Promise<void>;

export interface OrchestratorDeps {
  db: DatabaseSync;
  resolveComfy: () => ComfyClient;
  resolvePiper: () => PiperClient;
  ffmpeg?: FfmpegFn;
  /** Frames rendered per I2V transition. Default 33. */
  framesPerTransition?: number;
}

type Stage = 'tts' | 'images' | 'transitions' | 'assemble';

const RANGES: Record<Stage, [number, number]> = {
  tts: [0, 0.15],
  images: [0.15, 0.55],
  transitions: [0.55, 0.85],
  assemble: [0.85, 1],
};
const KEN_BURNS_ZOOM = 1.08;
const pad = (i: number) => String(i).padStart(2, '0');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function seedFor(draftId: string, sceneIndex: number): number {
  return createHash('sha256').update(`${draftId}:${sceneIndex}`).digest().readUInt32BE(0);
}

function abortError(): Error {
  const e = new Error('Job cancelled');
  e.name = 'AbortError';
  return e;
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
    // Stops a render that is already running on the GPU instead of waiting for it to finish.
    signal.addEventListener('abort', interruptOnce, { once: true });
    const guard = () => {
      if (!signal.aborted) return;
      interruptOnce();
      throw abortError();
    };
    const fail = (stage: Stage, what: string, e: unknown): never => {
      guard();
      throw new Error(`${stage} failed for ${what}: ${message(e)}`);
    };
    const begin = (stage: Stage, msg?: string) => {
      emit({ type: 'stage', stage, progress: RANGES[stage][0], ...(msg ? { message: msg } : {}) });
    };
    const step = (stage: Stage, done: number, total: number) => {
      const [lo, hi] = RANGES[stage];
      emit({ type: 'progress', stage, progress: lo + ((hi - lo) * done) / total });
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

    try {
      const n = escaleta.length;
      const audioDir = join(workDir, 'audio');
      const stillsDir = join(workDir, 'stills');
      const transDir = join(workDir, 'transitions');
      const clipsDir = join(workDir, 'clips');
      for (const d of [audioDir, stillsDir, transDir, clipsDir]) mkdirSync(d, { recursive: true });
      const prefix = `vs_${draft.id.slice(0, 8)}`;
      const sceneFile = (dir: string, name: string, i: number, ext: string) => join(dir, `${name}_${pad(i)}.${ext}`);

      begin('tts');
      const wavPaths: string[] = [];
      const durations: number[] = [];
      let format: ReturnType<typeof parseWav>['format'] | undefined;
      for (let i = 0; i < n; i++) {
        guard();
        let wav: Buffer;
        try {
          wav = await piper.synthesize({ text: escaleta[i].narration, voice: escaleta[i].voice });
          durations.push(wavDurationSec(wav));
          format ??= parseWav(wav).format;
        } catch (e) {
          return fail('tts', `scene ${i + 1}`, e);
        }
        const path = sceneFile(audioDir, 'scene', i, 'wav');
        writeFileSync(path, wav);
        wavPaths.push(path);
        step('tts', i + 1, n);
      }

      begin('images');
      const pngs: string[] = [];
      for (let i = 0; i < n; i++) {
        guard();
        try {
          const id = await comfy.submit(
            buildT2VWorkflow({
              prompt: escaleta[i].visualPrompt,
              seed: seedFor(draft.id, i),
              numFrames: 1,
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
        step('images', i + 1, n);
      }

      begin('transitions');
      const transitions: Array<string | undefined> = [];
      for (let i = 0; i < n - 1; i++) {
        guard();
        try {
          const start = await comfy.uploadImage(readFileSync(pngs[i]), `${prefix}_scene_${pad(i)}.png`);
          const end = await comfy.uploadImage(readFileSync(pngs[i + 1]), `${prefix}_scene_${pad(i + 1)}.png`);
          const id = await comfy.submit(
            buildI2VWorkflow({
              startImage: start,
              endImage: end,
              prompt: escaleta[i + 1].visualPrompt,
              seed: seedFor(draft.id, 1000 + i),
              numFrames: frames,
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
          begin('transitions', `transition ${i} failed, using a hard cut: ${message(e)}`);
        }
        step('transitions', i + 1, n - 1);
      }

      begin('assemble');
      const videoParts: string[] = [];
      const audioParts: string[] = [];
      // ComfyUI renders at DEFAULTS.fps (16); the normalized transition keeps that duration.
      const transitionSec = frames / DEFAULTS.fps;
      for (let i = 0; i < n; i++) {
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
          writeFileSync(silence, wavSilence(transitionSec, format as NonNullable<typeof format>));
          audioParts.push(silence);
        }
        step('assemble', i + 1, n);
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
      await run(muxAudioArgs({ video, audio: narration, out: finalPath }));
      return { outputPath: finalPath };
    } finally {
      signal.removeEventListener('abort', interruptOnce);
    }
  };
}
