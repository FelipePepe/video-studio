import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildConcatList,
  burnSubtitlesArgs,
  concatArgs,
  coverArgs,
  extractFrameArgs,
  kenBurnsArgs,
  muxAudioArgs,
  normalizeClipArgs,
  runFfmpeg,
  verticalCropArgs,
  verticalBurnSubtitlesArgs,
  VIDEO_CRF,
  xfadeArgs,
} from '../src/media/ffmpeg';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function fakeSpawn(code: number, stderr = '') {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', code);
    });
    return proc;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl, calls };
}

test('runFfmpeg prefixes global flags and resolves on exit 0', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  await runFfmpeg(['-i', 'a.mp4', 'b.mp4'], { spawnImpl });
  assert.equal(calls[0].cmd, 'ffmpeg');
  assert.deepEqual(calls[0].args, ['-y', '-hide_banner', '-i', 'a.mp4', 'b.mp4']);
});

test('runFfmpeg rejects with the last stderr lines on non-zero exit', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
  const { spawnImpl } = fakeSpawn(1, lines);
  await assert.rejects(runFfmpeg(['x'], { spawnImpl }), (e: Error) => {
    assert.match(e.message, /exited with code 1/);
    assert.match(e.message, /line29/);
    assert.doesNotMatch(e.message, /line0\b/);
    return true;
  });
});

test('runFfmpeg rejects when spawn emits an error', async () => {
  const spawnImpl = (() => {
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => proc.emit('error', new Error('ENOENT')));
    return proc;
  }) as unknown as typeof import('node:child_process').spawn;
  await assert.rejects(runFfmpeg(['x'], { spawnImpl }), /ffmpeg failed to start.*ENOENT/);
});

test('runFfmpeg rejects immediately when the signal is already aborted', async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runFfmpeg(['x'], { spawnImpl, signal: ac.signal }), /aborted/i);
  assert.equal(calls.length, 0);
});

test('kenBurnsArgs builds a zoompan clip with defaults', () => {
  const args = kenBurnsArgs({ image: 'in.png', durationSec: 5, out: 'out.mp4' });
  assert.deepEqual(args, [
    '-loop', '1', '-framerate', '24', '-i', 'in.png',
    '-vf',
    "scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440," +
      "zoompan=z='min(1+0.00125*on,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=24,format=yuv420p",
    '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', 'out.mp4',
  ]);
});

test('VIDEO_CRF is 18 and every intermediate encode passes it explicitly', () => {
  assert.equal(VIDEO_CRF, 18);
  const builderArgs: Array<[string, string[]]> = [
    ['kenBurnsArgs', kenBurnsArgs({ image: 'i', durationSec: 1, out: 'o' })],
    ['xfadeArgs', xfadeArgs({ clips: ['a', 'b'], durationsSec: [3, 3], transitionSec: 1, out: 'o' })],
    ['normalizeClipArgs', normalizeClipArgs({ input: 'i', out: 'o' })],
    ['burnSubtitlesArgs', burnSubtitlesArgs({ input: 'i', srt: 's.srt', out: 'o' })],
    ['verticalCropArgs', verticalCropArgs({ input: 'i', out: 'o' })],
    ['verticalBurnSubtitlesArgs', verticalBurnSubtitlesArgs({ input: 'i', srt: 's.srt', out: 'o' })],
  ];
  for (const [name, args] of builderArgs) {
    assert.ok(args.includes('-crf'), `${name} carries an explicit -crf`);
    assert.equal(args[args.indexOf('-crf') + 1], String(VIDEO_CRF), `${name} uses CRF ${VIDEO_CRF}`);
  }
});

test('kenBurnsArgs honors size, fps and zoom and validates input', () => {
  const args = kenBurnsArgs({ image: 'i', durationSec: 2, out: 'o', width: 640, height: 360, fps: 10, zoomTo: 1.2 });
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /s=640x360:fps=10/);
  assert.match(vf, /min\(1\+0\.01\*on,1\.2\)/);
  assert.throws(() => kenBurnsArgs({ image: 'i', durationSec: 0, out: 'o' }), /duration/);
  assert.throws(() => kenBurnsArgs({ image: 'i', durationSec: 1, out: 'o', zoomTo: 0.9 }), /zoomTo/);
});

test('kenBurnsArgs supports zoom-out (starts at zoomTo, ends at 1×)', () => {
  const args = kenBurnsArgs({ image: 'i', durationSec: 10, out: 'o', zoomTo: 1.2, direction: 'zoom-out' });
  const filter = args[args.indexOf('-vf') + 1];
  assert.match(filter, /max\(1\.2-[\d.]+\*on,1\)/, `got: ${filter}`);
  assert.match(filter, /zoompan/);
});

test('xfadeArgs chains xfade filters with cumulative offsets', () => {
  const args = xfadeArgs({ clips: ['a.mp4', 'b.mp4', 'c.mp4'], durationsSec: [5, 4, 6], transitionSec: 1, out: 'o.mp4' });
  assert.deepEqual(args, [
    '-i', 'a.mp4', '-i', 'b.mp4', '-i', 'c.mp4',
    '-filter_complex',
    '[0:v][1:v]xfade=transition=fade:duration=1:offset=4[v1];[v1][2:v]xfade=transition=fade:duration=1:offset=7[v2]',
    '-map', '[v2]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', 'o.mp4',
  ]);
});

test('xfadeArgs with two clips maps [v1]', () => {
  const args = xfadeArgs({ clips: ['a', 'b'], durationsSec: [3, 3], transitionSec: 0.5, out: 'o' });
  assert.match(args[args.indexOf('-filter_complex') + 1], /^\[0:v\]\[1:v\]xfade=transition=fade:duration=0\.5:offset=2\.5\[v1\]$/);
  assert.equal(args[args.indexOf('-map') + 1], '[v1]');
});

test('xfadeArgs validates inputs', () => {
  assert.throws(() => xfadeArgs({ clips: ['a'], durationsSec: [3], transitionSec: 1, out: 'o' }), /at least 2/);
  assert.throws(() => xfadeArgs({ clips: ['a', 'b'], durationsSec: [3], transitionSec: 1, out: 'o' }), /durations/);
  assert.throws(() => xfadeArgs({ clips: ['a', 'b'], durationsSec: [3, 1], transitionSec: 1, out: 'o' }), /shorter than|less than/);
  assert.throws(() => xfadeArgs({ clips: ['a', 'b'], durationsSec: [3, 3], transitionSec: 0, out: 'o' }), /transition/);
});

test('concatArgs and buildConcatList', () => {
  assert.deepEqual(concatArgs({ listFile: 'l.txt', out: 'o.mp4' }), ['-f', 'concat', '-safe', '0', '-i', 'l.txt', '-c', 'copy', 'o.mp4']);
  assert.equal(buildConcatList(['/a/1.mp4', "/a/it's.mp4"]), "file '/a/1.mp4'\nfile '/a/it'\\''s.mp4'\n");
  assert.throws(() => buildConcatList([]), /at least one/);
});

test('muxAudioArgs copies video and encodes aac', () => {
  assert.deepEqual(muxAudioArgs({ video: 'v.mp4', audio: 'a.wav', out: 'o.mp4' }), [
    '-i', 'v.mp4', '-i', 'a.wav',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'o.mp4',
  ]);
});

test('kenBurns renders a real clip with ffmpeg', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-ffmpeg-'));
  try {
    const img = join(dir, 'in.png');
    const out = join(dir, 'out.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', img]);
    await runFfmpeg(kenBurnsArgs({ image: img, durationSec: 1, out, width: 320, height: 180, fps: 12 }));
    assert.ok(existsSync(out));
    assert.ok(statSync(out).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractFrameArgs grabs the first frame', () => {
  assert.deepEqual(extractFrameArgs({ video: 'a.mp4', out: 'a.png' }), ['-i', 'a.mp4', '-frames:v', '1', 'a.png']);
});

test('coverArgs fast-seeks on the input side', () => {
  const args = coverArgs({ input: 'a.mp4', atSec: 12.5, out: 'cover.jpg' });
  assert.deepEqual(args, ['-ss', '12.5', '-i', 'a.mp4', '-frames:v', '1', '-q:v', '3', 'cover.jpg']);
  assert.throws(() => coverArgs({ input: 'a.mp4', atSec: -1, out: 'c.jpg' }), /non-negative/);
});

test('verticalBurnSubtitlesArgs folds crop + scale + subtitles into a single encode', () => {
  assert.deepEqual(verticalBurnSubtitlesArgs({ input: 'v.mp4', srt: 'sub.srt', out: 'out.mp4' }), [
    '-i', 'v.mp4',
    '-vf', 'crop=ih*9/16:ih,scale=720:1280,subtitles=sub.srt',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    'out.mp4',
  ]);
});

test('verticalBurnSubtitlesArgs sanitizes the force style and escapes the SRT path', () => {
  const args = verticalBurnSubtitlesArgs({ input: 'v.mp4', srt: "c:\\vid\\sub.srt", out: 'out.mp4', style: "Fontname=Arial, Fontsize='20'" });
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.startsWith('crop=ih*9/16:ih,scale=720:1280,subtitles='), 'filter chain order');
  assert.ok(vf.includes('subtitles=c\\:\\\\vid\\\\sub.srt'), 'backslash and drive-colon escaping');
  assert.ok(vf.includes("force_style='Fontname=Arial, Fontsize=20'"), 'quotes stripped from force_style');
  assert.ok(!vf.includes("''"), 'no double-quote artifacts');
});

test('normalizeClipArgs re-encodes to the shared stream parameters', () => {
  const args = normalizeClipArgs({ input: 't.mp4', out: 'n.mp4' });
  assert.deepEqual(args, [
    '-i', 't.mp4',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1,format=yuv420p',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', 'n.mp4',
  ]);
  assert.match(normalizeClipArgs({ input: 'a', out: 'b', width: 640, height: 360, fps: 30 }).join(' '), /scale=640:360.*pad=640:360.*fps=30/);
});

test('fast preset on every re-encode so vertical + subtitles stays one pass', () => {
  assert.ok(kenBurnsArgs({ image: 'i', durationSec: 1, out: 'o' }).includes('veryfast'), 'kenBurns veryfast');
  assert.ok(normalizeClipArgs({ input: 'i', out: 'o' }).includes('veryfast'), 'normalizeClip veryfast');
  assert.ok(burnSubtitlesArgs({ input: 'i', srt: 's.srt', out: 'o' }).includes('veryfast'), 'burn veryfast');
  assert.ok(verticalCropArgs({ input: 'i', out: 'o' }).includes('veryfast'), 'crop veryfast');
  assert.ok(verticalBurnSubtitlesArgs({ input: 'i', srt: 's.srt', out: 'o' }).includes('veryfast'), 'chained vertical+subtitles veryfast');
});

/** A child that never exits on its own: it closes only after `kill` is called. */
function hangingSpawn() {
  const kills: Array<string | number | undefined> = [];
  const spawnImpl = (() => {
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: (s?: string | number) => void };
    proc.stderr = new EventEmitter();
    proc.kill = (sig) => {
      kills.push(sig);
      setImmediate(() => proc.emit('close', null));
    };
    return proc;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl, kills };
}

test('runFfmpeg kills with SIGKILL and rejects when ffmpeg goes silent (stall watchdog)', async () => {
  const { spawnImpl, kills } = hangingSpawn();
  await assert.rejects(runFfmpeg(['x'], { spawnImpl, stallTimeoutMs: 20 }), /ffmpeg stalled: no output for 20ms/);
  assert.deepEqual(kills, ['SIGKILL']);
});

/** A child that keeps printing progress every `everyMs` for `count` ticks, then exits 0. */
function chattySpawn(everyMs: number, count: number) {
  const kills: Array<string | number | undefined> = [];
  const spawnImpl = (() => {
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: (s?: string | number) => void };
    proc.stderr = new EventEmitter();
    proc.kill = (sig) => {
      kills.push(sig);
    };
    let n = 0;
    const tick = setInterval(() => {
      proc.stderr.emit('data', Buffer.from(`frame=${n} time=00:00:0${n}\r`));
      if (++n >= count) {
        clearInterval(tick);
        proc.emit('close', 0);
      }
    }, everyMs);
    return proc;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl, kills };
}

test('runFfmpeg does NOT kill a slow encode that keeps printing progress (total time may exceed the stall limit)', async () => {
  // 6 ticks x 25ms = ~150ms of work against a 60ms stall limit: progress output keeps resetting the watchdog.
  const { spawnImpl, kills } = chattySpawn(25, 6);
  await runFfmpeg(['x'], { spawnImpl, stallTimeoutMs: 60 });
  assert.deepEqual(kills, []);
});

test('runFfmpeg kills and rejects aborted on a mid-run abort', async () => {
  const { spawnImpl, kills } = hangingSpawn();
  const ac = new AbortController();
  const p = runFfmpeg(['x'], { spawnImpl, signal: ac.signal, stallTimeoutMs: 5000 });
  setImmediate(() => ac.abort());
  await assert.rejects(p, /ffmpeg aborted/);
  assert.deepEqual(kills, ['SIGKILL']);
});

/**
 * Records watchdog delays without arming a real timer. Heuristic: every watchdog value used by these
 * tests is >= 1000 ms, while the fakes' own timers are a few ms. A different setTimeout >= 1 s during
 * runFfmpeg would be swallowed here, and a watchdog < 1000 ms would arm a real timer: keep that in mind.
 */
function spyTimeouts() {
  const delays: unknown[] = [];
  const original = global.setTimeout;
  global.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === 'number' && ms >= 1000) {
      // Record the watchdog delay but do not arm a real timer.
      delays.push(ms);
      return { unref() {}, ref() {} } as unknown as NodeJS.Timeout;
    }
    return original(fn, ms, ...(rest as []));
  }) as typeof setTimeout;
  return { delays, restore: () => (global.setTimeout = original) };
}

test('runFfmpeg stallTimeoutMs option beats FFMPEG_STALL_TIMEOUT_MS; invalid or empty env falls back to 10 minutes', async () => {
  const saved = process.env.FFMPEG_STALL_TIMEOUT_MS;
  const spy = spyTimeouts();
  try {
    process.env.FFMPEG_STALL_TIMEOUT_MS = '7000';
    await runFfmpeg(['x'], { spawnImpl: fakeSpawn(0).spawnImpl, stallTimeoutMs: 4000 });
    await runFfmpeg(['x'], { spawnImpl: fakeSpawn(0).spawnImpl });
    for (const bad of ['', 'abc', '0', '-5']) {
      process.env.FFMPEG_STALL_TIMEOUT_MS = bad;
      await runFfmpeg(['x'], { spawnImpl: fakeSpawn(0).spawnImpl });
    }
    delete process.env.FFMPEG_STALL_TIMEOUT_MS;
    await runFfmpeg(['x'], { spawnImpl: fakeSpawn(0).spawnImpl });
  } finally {
    spy.restore();
    if (saved === undefined) delete process.env.FFMPEG_STALL_TIMEOUT_MS;
    else process.env.FFMPEG_STALL_TIMEOUT_MS = saved;
  }
  assert.deepEqual(spy.delays, [4000, 7000, 600_000, 600_000, 600_000, 600_000, 600_000]);
});

test('runFfmpeg caps an oversized stall timeout at the largest setTimeout delay (no 1 ms overflow)', async () => {
  const saved = process.env.FFMPEG_STALL_TIMEOUT_MS;
  const spy = spyTimeouts();
  try {
    process.env.FFMPEG_STALL_TIMEOUT_MS = '3000000000'; // > 2^31-1: Node would clamp it to 1 ms
    await runFfmpeg(['x'], { spawnImpl: fakeSpawn(0).spawnImpl });
    delete process.env.FFMPEG_STALL_TIMEOUT_MS;
    await runFfmpeg(['x'], { spawnImpl: fakeSpawn(0).spawnImpl, stallTimeoutMs: 1e10 });
  } finally {
    spy.restore();
    if (saved === undefined) delete process.env.FFMPEG_STALL_TIMEOUT_MS;
    else process.env.FFMPEG_STALL_TIMEOUT_MS = saved;
  }
  assert.deepEqual(spy.delays, [2_147_483_647, 2_147_483_647]);
});
