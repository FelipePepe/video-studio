import { spawn as nodeSpawn } from 'node:child_process';

export interface RunFfmpegOptions {
  spawnImpl?: typeof nodeSpawn;
  signal?: AbortSignal;
}

const STDERR_TAIL_LINES = 15;
const num = (n: number) => String(Number(n.toFixed(6)));

export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
  const { spawnImpl = nodeSpawn, signal } = opts;
  if (signal?.aborted) return Promise.reject(new Error('ffmpeg aborted'));
  return new Promise<void>((resolve, reject) => {
    const proc = spawnImpl('ffmpeg', ['-y', '-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8192);
    });
    const onAbort = () => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`ffmpeg failed to start: ${e.message}`));
    });
    proc.on('close', (code: number | null) => {
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
}

export function kenBurnsArgs(o: KenBurnsOptions): string[] {
  const { image, durationSec, out, width = 1280, height = 720, fps = 24, zoomTo = 1.15 } = o;
  if (!(durationSec > 0)) throw new Error('kenBurns duration must be greater than 0');
  if (!(zoomTo >= 1)) throw new Error('kenBurns zoomTo must be at least 1');
  const inc = num((zoomTo - 1) / (fps * durationSec));
  const vf =
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},` +
    `zoompan=z='min(1+${inc}*on,${num(zoomTo)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},format=yuv420p`;
  return [
    '-loop', '1', '-framerate', String(fps), '-i', image,
    '-vf', vf,
    '-t', num(durationSec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
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
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ];
}

export function concatArgs(o: { listFile: string; out: string }): string[] {
  return ['-f', 'concat', '-safe', '0', '-i', o.listFile, '-c', 'copy', o.out];
}

export function buildConcatList(files: string[]): string {
  if (files.length === 0) throw new Error('concat list needs at least one file');
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

export function muxAudioArgs(o: { video: string; audio: string; out: string }): string[] {
  return [
    '-i', o.video, '-i', o.audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', o.out,
  ];
}
