import { spawn as nodeSpawn } from 'node:child_process';

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

/** Center-crops the 16:9 film to 9:16 and scales it to 720x1280 (Shorts/Reels); audio copied. */
export function verticalCropArgs(o: { input: string; out: string }): string[] {
  return [
    '-i', o.input,
    '-vf', 'crop=ih*9/16:ih,scale=720:1280',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    o.out,
  ];
}

/**
 * Vertical 9:16 output with burned subtitles in a SINGLE x264 pass (crop + scale + subtitles
 * chained in one -vf), instead of cropping and then burning as two re-encodes. Audio copied.
 */
export function verticalBurnSubtitlesArgs(o: { input: string; srt: string; out: string; style?: string }): string[] {
  return [
    '-i', o.input,
    '-vf', `crop=ih*9/16:ih,scale=720:1280,${subtitleFilter(o.srt, o.style)}`,
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
