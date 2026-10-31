import { spawn as nodeSpawn } from 'node:child_process';
import type { MouthState } from './audioEnvelope';

export interface RunFfmpegOptions {
  spawnImpl?: typeof nodeSpawn;
  signal?: AbortSignal;
  /**
   * Stall watchdog: kill ffmpeg when it prints nothing for this many ms. Defaults to
   * FFMPEG_STALL_TIMEOUT_MS, then 10 minutes. It is an INACTIVITY limit, not a total-time limit:
   * ffmpeg prints progress to stderr while it encodes, so a slow but progressing encode (a long
   * final render on a Raspberry Pi) keeps resetting it and is never killed; only a hung process is.
   */
  stallTimeoutMs?: number;
}

const DEFAULT_FFMPEG_STALL_TIMEOUT_MS = 600_000;
/** Largest delay setTimeout accepts; a bigger value is clamped by Node to 1 ms (it would kill every run). */
const MAX_TIMER_MS = 2_147_483_647;

function resolveStallTimeoutMs(option: number | undefined): number {
  let ms = DEFAULT_FFMPEG_STALL_TIMEOUT_MS;
  if (typeof option === 'number' && Number.isFinite(option) && option > 0) ms = option;
  else {
    const raw = (process.env.FFMPEG_STALL_TIMEOUT_MS ?? '').trim();
    const parsed = raw === '' ? NaN : Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) ms = parsed;
  }
  return Math.min(ms, MAX_TIMER_MS);
}

const STDERR_TAIL_LINES = 15;
const num = (n: number) => String(Number(n.toFixed(6)));

/**
 * CRF used on every intermediate libx264 encode (Ken Burns, xfade, normalize, vertical passes).
 * Clips are joined with `concat -c copy`, so this CRF is the final video quality — explicit,
 * higher than the x264 default (23) instead of an accidental fallback.
 */
export const VIDEO_CRF = 18;

export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
  const { spawnImpl = nodeSpawn, signal } = opts;
  if (signal?.aborted) return Promise.reject(new Error('ffmpeg aborted'));
  return new Promise<void>((resolve, reject) => {
    const proc = spawnImpl('ffmpeg', ['-y', '-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const stallMs = resolveStallTimeoutMs(opts.stallTimeoutMs);
    let timer: NodeJS.Timeout;
    // Re-armed on every chunk of output: only a process that stops printing is considered stuck.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        proc.kill('SIGKILL');
        reject(new Error(`ffmpeg stalled: no output for ${stallMs}ms`));
      }, stallMs);
    };
    arm();
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8192);
      arm();
    });
    function onAbort() {
      clearTimeout(timer);
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`ffmpeg failed to start: ${e.message}`));
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}:\n${tail}`));
    });
  });
}

export interface KenBurnsOptions {
  image: string;
  durationSec: number;
  out: string;
  width?: number;
  height?: number;
  fps?: number;
  zoomTo?: number;
  direction?: 'zoom-in' | 'zoom-out';
}

export function kenBurnsArgs(o: KenBurnsOptions): string[] {
  const { image, durationSec, out, width = 1280, height = 720, fps = 24, zoomTo = 1.15, direction = 'zoom-in' } = o;
  if (!(durationSec > 0)) throw new Error('kenBurns duration must be greater than 0');
  if (!(zoomTo >= 1)) throw new Error('kenBurns zoomTo must be at least 1');
  const inc = num((zoomTo - 1) / (fps * durationSec));
  // zoom-in: starts at 1×, ends at zoomTo. zoom-out: starts at zoomTo, ends at 1×.
  const z = direction === 'zoom-out'
    ? `max(${num(zoomTo)}-${inc}*on,1)`
    : `min(1+${inc}*on,${num(zoomTo)})`;
  // 4× oversampling (not 2×): zoompan rounds its x/y pan offsets to integers, so at 2× each
  // step can shift ~half an output pixel and reads as visible jitter; at 4× the rounding error
  // is a quarter of a pixel. lanczos keeps the upscale honest instead of the sws default.
  const vf =
    `scale=${width * 4}:${height * 4}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width * 4}:${height * 4},` +
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},format=yuv420p`;
  return [
    '-loop', '1', '-framerate', String(fps), '-i', image,
    '-vf', vf,
    '-t', num(durationSec), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p', out,
  ];
}

export interface XfadeOptions {
  clips: string[];
  durationsSec: number[];
  transitionSec: number;
  out: string;
}

export function xfadeArgs(o: XfadeOptions): string[] {
  const { clips, durationsSec, transitionSec, out } = o;
  if (clips.length < 2) throw new Error('xfade needs at least 2 clips');
  if (durationsSec.length !== clips.length) throw new Error('xfade durations must match clips length');
  if (!(transitionSec > 0)) throw new Error('xfade transition must be greater than 0');
  if (durationsSec.some((d) => !(d > transitionSec))) {
    throw new Error('xfade transition must be shorter than every clip duration');
  }
  const filters: string[] = [];
  let elapsed = durationsSec[0];
  for (let i = 1; i < clips.length; i++) {
    const offset = num(elapsed - i * transitionSec);
    const left = i === 1 ? '[0:v]' : `[v${i - 1}]`;
    filters.push(`${left}[${i}:v]xfade=transition=fade:duration=${num(transitionSec)}:offset=${offset}[v${i}]`);
    elapsed += durationsSec[i];
  }
  return [
    ...clips.flatMap((c) => ['-i', c]),
    '-filter_complex', filters.join(';'),
    '-map', `[v${clips.length - 1}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p', out,
  ];
}

export function concatArgs(o: { listFile: string; out: string }): string[] {
  return ['-f', 'concat', '-safe', '0', '-i', o.listFile, '-c', 'copy', o.out];
}

export function buildConcatList(files: string[]): string {
  if (files.length === 0) throw new Error('concat list needs at least one file');
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

export interface MusicMixOptions {
  video: string;
  audio: string;
  music: string;
  out: string;
  musicVolume?: number;
}

export function muxAudioArgs(o: { video: string; audio: string; out: string }): string[] {
  return [
    '-i', o.video, '-i', o.audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', o.out,
  ];
}

/**
 * Muxes the narration over the video (input 1) and an optional BGM (input 2),
 * ducking the music with a sidechain compressor driven by the narration so the
 * voice always stays on top. Music is volume-scaled first, mixed with
 * `amix=duration=first` so its tail is cut when the narration ends.
 */
export function musicMixArgs(o: MusicMixOptions): string[] {
  const volume = o.musicVolume ?? 0.25;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0 || volume > 1) {
    throw new Error('musicVolume must be a number in (0, 1]');
  }
  const num = (v: number) => String(v);
  const filter =
    `[2:a]volume=${num(volume)}[m];` +
    `[m][1:a]sidechaincompress=threshold=0.15:ratio=8:attack=50:release=400[bg];` +
    `[1:a][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`;
  return [
    '-i', o.video, '-i', o.audio, '-i', o.music,
    '-filter_complex', filter,
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    o.out,
  ];
}

export function extractFrameArgs(o: { video: string; out: string }): string[] {
  return ['-i', o.video, '-frames:v', '1', o.out];
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** Re-encodes the video stream to burn a subtitle track (SRT) in; audio is copied. */
export function burnSubtitlesArgs(o: { input: string; srt: string; out: string; style?: string }): string[] {
  const vf = subtitleFilter(o.srt, o.style);
  return [
    '-i', o.input,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    o.out,
  ];
}

/**
 * filter_complex fragment that fits the 16:9 frame into 720x1280 without upscaling the subject:
 * the full frame is scaled to 720 wide and centered over a blurred, cropped copy of itself.
 * Outputs the label [v]; `trailing` (e.g. a subtitles filter) is chained after the overlay.
 */
function verticalFitFilter(trailing?: string): string {
  const base =
    '[0:v]split=2[bg][fg];' +
    '[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:2[b];' +
    '[fg]scale=720:-2[f];' +
    '[b][f]overlay=(W-w)/2:(H-h)/2';
  return trailing ? `${base}[o];[o]${trailing}[v]` : `${base}[v]`;
}

/** Fits the 16:9 film into 9:16 (720x1280) over a blurred background (Shorts/Reels); audio copied. */
export function verticalCropArgs(o: { input: string; out: string }): string[] {
  return [
    '-i', o.input,
    '-filter_complex', verticalFitFilter(),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    o.out,
  ];
}

/**
 * Vertical 9:16 output with burned subtitles in a SINGLE x264 pass (fit + subtitles chained in
 * one filter_complex), instead of fitting and then burning as two re-encodes. Audio copied.
 */
export function verticalBurnSubtitlesArgs(o: { input: string; srt: string; out: string; style?: string }): string[] {
  return [
    '-i', o.input,
    '-filter_complex', verticalFitFilter(subtitleFilter(o.srt, o.style)),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    o.out,
  ];
}

function subtitleFilter(srt: string, style?: string): string {
  return style
    ? `subtitles=${escapeFilterPath(srt)}:force_style='${style.replace(/'/g, '')}'`
    : `subtitles=${escapeFilterPath(srt)}`;
}

/** Extracts a single frame (JPEG cover) at the given timestamp; input-side -ss fast-seeks. */
export function coverArgs(o: { input: string; atSec: number; out: string }): string[] {
  if (!Number.isFinite(o.atSec) || o.atSec < 0) throw new Error('coverArgs: atSec must be a non-negative number');
  return ['-ss', String(o.atSec), '-i', o.input, '-frames:v', '1', '-q:v', '3', o.out];
}

export interface NormalizeClipOptions {
  input: string;
  out: string;
  width?: number;
  height?: number;
  fps?: number;
}

/** Re-encodes a clip to the Ken Burns stream parameters so the concat demuxer can join them. */
export function normalizeClipArgs(o: NormalizeClipOptions): string[] {
  const { input, out, width = 1280, height = 720, fps = 24 } = o;
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1,format=yuv420p`;
  return ['-i', input, '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p', out];
}

// -- Presenters: felt-puppet mouth animation via jaw drop (pure arg builders) -----------------------------------

const MOUTH_STATE_SCALE: Record<MouthState, number> = { closed: 0, mid: 0.5, open: 1 };

export interface PresenterSpriteOptions {
  image: string;
  out: string;               // .png
  state: MouthState;
  mouthY?: number;           // where the jaw splits, fraction of the image height. default 0.55, must be in [0.1, 0.9]
  drop?: number;             // max jaw drop as a fraction of the image height. default 0.06, must be in (0, 0.3]
  keyColor?: string;         // default '0x00FF00'
  keySimilarity?: number;    // default 0.28
  keyBlend?: number;         // default 0.08
}

/**
 * Builds one presenter sprite for a mouth state: green key to alpha, a canvas pad for the
 * jaw travel, a darkened copy showing through the gap, and the jaw (bottom crop) offset by
 * the state's drop fraction (0 closed / 0.5 mid / 1 open).
 */
export function presenterSpriteArgs(o: PresenterSpriteOptions): string[] {
  if (o.state !== 'closed' && o.state !== 'mid' && o.state !== 'open') {
    throw new Error('presenterSprite: state must be "closed", "mid" or "open"');
  }
  const mouthY = o.mouthY ?? 0.55;
  const drop = o.drop ?? 0.06;
  if (typeof mouthY !== 'number' || !Number.isFinite(mouthY) || mouthY < 0.1 || mouthY > 0.9) {
    throw new Error('presenterSprite: mouthY must be a finite number in [0.1, 0.9]');
  }
  if (typeof drop !== 'number' || !Number.isFinite(drop) || drop <= 0 || drop > 0.3) {
    throw new Error('presenterSprite: drop must be a finite number in (0, 0.3]');
  }
  const my = num(mouthY);
  const dl = num(drop);
  const key = `${o.keyColor ?? '0x00FF00'}:${o.keySimilarity ?? 0.28}:${o.keyBlend ?? 0.08}`;
  const s = num(MOUTH_STATE_SCALE[o.state]);
  const filter =
    `[0:v]format=rgba,chromakey=${key},split=4[c][d][a][b];` +
    `[c]colorchannelmixer=aa=0,pad=iw:ceil(ih*(1+${dl})):0:0:color=0x00000000[canvas];` +
    `[d]lutrgb=r=val*0.25:g=val*0.2:b=val*0.2[dark];` +
    `[a]crop=iw:floor(ih*${my}):0:0[top];` +
    `[b]crop=iw:ih-floor(ih*${my}):0:floor(ih*${my})[bot];` +
    `[canvas][dark]overlay=0:0:format=auto[c0];` +
    `[c0][top]overlay=0:0:format=auto[c1];` +
    `[c1][bot]overlay=0:floor(main_h/(1+${dl})*${my})+round(main_h/(1+${dl})*${dl}*${s}):format=auto`;
  return ['-i', o.image, '-filter_complex', filter, '-frames:v', '1', o.out];
}

/**
 * Concat-demuxer script for a mouth-state timeline: consecutive equal states are merged
 * into one `file`/`duration` run (duration = run length / fps), and the last file is
 * repeated once at the end because the concat demuxer ignores the duration of the final
 * entry.
 */
export function presenterConcatList(states: MouthState[], sprites: Record<MouthState, string>, fps = 24): string {
  if (states.length === 0) throw new Error('presenterConcatList needs at least one state');
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('presenterConcatList: fps must be a positive number');
  }
  const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const lines: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= states.length; i++) {
    if (i === states.length || states[i] !== states[runStart]) {
      const sprite = sprites[states[runStart]];
      if (typeof sprite !== 'string' || sprite.length === 0) {
        throw new Error(`presenterConcatList: missing sprite path for state "${states[runStart]}"`);
      }
      lines.push(`file ${quote(sprite)}`, `duration ${num((i - runStart) / fps)}`);
      runStart = i;
    }
  }
  lines.push(`file ${quote(sprites[states[states.length - 1]])}`);
  return lines.join('\n') + '\n';
}

/**
 * Concatenates the sprite timeline into a .mov with an alpha channel (qtrle keeps alpha).
 * `frames` is required and positive: callers pass states.length, because without an
 * explicit `-frames:v N` the clip length is not frame-exact and the presenter drifts.
 */
export function presenterClipArgs(o: {
  listFile: string;
  out: string;
  fps?: number;
  frames: number;
}): string[] {
  if (!Number.isInteger(o.frames) || o.frames <= 0) {
    throw new Error('presenterClipArgs: frames must be a positive integer');
  }
  const fps = o.fps ?? 24;
  return [
    '-f', 'concat', '-safe', '0', '-i', o.listFile,
    '-vf', `fps=${fps},format=argb`, '-c:v', 'qtrle',
    '-frames:v', String(o.frames), o.out,
  ];
}

/**
 * Composites two presenter clips with alpha (T11 qtrle .mov) over the background video in ONE
 * x264 pass: A bottom-left, B bottom-right. Presenters are sized by heightRatio so the clip's
 * width (scale=-2) is derived, and both clips are as long as the whole video, so overlays never
 * need a `:enable=` window. Audio is copied untouched.
 */
export interface PresenterOverlayOptions {
  video: string;             // background video (already without presenters)
  clipA: string;             // .mov with alpha
  clipB: string;             // .mov with alpha
  out: string;
  videoHeight: number;       // output height in px of `video` (e.g. 720, or 1280 for the vertical variant); positive integer
  heightRatio?: number;      // presenter height as a fraction of videoHeight. default 0.4, must be in (0.1, 0.9]
  marginRatio?: number;      // margin to the edges as a fraction of videoHeight. default 0.02, must be in [0, 0.2]
}

export function presenterOverlayArgs(o: PresenterOverlayOptions): string[] {
  const V = o.videoHeight;
  if (typeof V !== 'number' || !Number.isInteger(V) || V <= 0) {
    throw new Error('presenterOverlayArgs: videoHeight must be a positive integer');
  }
  const ratio = o.heightRatio ?? 0.4;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0.1 || ratio > 0.9) {
    throw new Error('presenterOverlayArgs: heightRatio must be a finite number in (0.1, 0.9]');
  }
  const marginRatio = o.marginRatio ?? 0.02;
  if (typeof marginRatio !== 'number' || !Number.isFinite(marginRatio) || marginRatio < 0 || marginRatio > 0.2) {
    throw new Error('presenterOverlayArgs: marginRatio must be a finite number in [0, 0.2]');
  }
  const H = 2 * Math.round(V * ratio / 2); // even, for yuv420p
  const M = Math.round(V * marginRatio);
  const filter =
    `[1:v]scale=-2:${H}[a];` +
    `[2:v]scale=-2:${H}[b];` +
    `[0:v][a]overlay=x=${M}:y=main_h-overlay_h-${M}:eof_action=pass:format=auto[t];` +
    `[t][b]overlay=x=main_w-overlay_w-${M}:y=main_h-overlay_h-${M}:eof_action=pass:format=auto[v]`;
  return [
    '-i', o.video, '-i', o.clipA, '-i', o.clipB,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', o.out,
  ];
}
