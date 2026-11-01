import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  presenterSpriteArgs,
  presenterMouthSpriteArgs,
  presenterConcatList,
  presenterClipArgs,
  presenterOverlayArgs,
  VIDEO_CRF,
  type PresenterOverlayOptions,
  type PresenterSpriteOptions,
} from '../src/media/ffmpeg.js';

const VIDEO = '/tmp/pipeline/background.mp4';
const CLIP_A = '/tmp/presA/clip.mov';
const CLIP_B = '/tmp/presB/clip.mov';
const OUT = '/tmp/pipeline/with_presenters.mp4';

const SPRITE = '/tmp/presenter/felt.png';

function filterOf(args: string[]): string {
  const i = args.indexOf('-filter_complex');
  assert.notEqual(i, -1, 'args must contain -filter_complex');
  return args[i + 1];
}

test('presenterSpriteArgs: one filter per mouth state with jaw drop scaling', () => {
  const S: Record<'closed' | 'mid' | 'open', string> = { closed: '0', mid: '0.5', open: '1' };
  for (const state of ['closed', 'mid', 'open'] as const) {
    const args = presenterSpriteArgs({ image: SPRITE, out: `/tmp/out_${state}.png`, state });
    const filter = filterOf(args);
    assert.match(filter, /chromakey=0x00FF00:0\.06:0\.02/, `chromakey defaults for ${state}`);
    assert.match(filter, /split=4/);
    assert.match(filter, /lutrgb=/);
    assert.ok(
      filter.includes(`round(main_h/(1+0.06)*0.06*${S[state]})`),
      `final overlay y-expression should scale by ${S[state]} for ${state}`,
    );
    assert.deepEqual(args.slice(0, 2), ['-i', SPRITE], `args head for ${state}`);
    assert.deepEqual(args.slice(-3), ['-frames:v', '1', `/tmp/out_${state}.png`], `args tail for ${state}`);
  }
});

test('presenterSpriteArgs: mouthY and drop defaults and overrides land in the filter', () => {
  const base: PresenterSpriteOptions = { image: SPRITE, out: '/tmp/out.png', state: 'open' };
  const d = filterOf(presenterSpriteArgs(base));
  assert.ok(d.includes('ih*0.55'), 'default mouthY 0.55 in crop expression');
  assert.ok(d.includes('(1+0.06)'), 'default drop 0.06 in pad/overlay expressions');

  const o = filterOf(presenterSpriteArgs({ ...base, mouthY: 0.6, drop: 0.1 }));
  assert.ok(o.includes('ih*0.6'), 'overridden mouthY in crop expression');
  assert.ok(o.includes('(1+0.1)'), 'overridden drop in pad expression');
});

test('presenterSpriteArgs: crop is first in the filter when provided', () => {
  const withCrop = filterOf(
    presenterSpriteArgs({
      image: SPRITE, out: '/tmp/out.png', state: 'closed',
      crop: { x: 100, y: 200, w: 300, h: 500 },
    }),
  );
  assert.ok(
    withCrop.startsWith('[0:v]crop=300:500:100:200,format=rgba,chromakey='),
    `filter must start with the crop, got: ${withCrop.slice(0, 80)}`,
  );
  assert.match(withCrop, /chromakey=0x00FF00:0\.06:0\.02/, 'defaults apply alongside the crop');

  const without = filterOf(presenterSpriteArgs({ image: SPRITE, out: '/tmp/out.png', state: 'closed' }));
  assert.ok(
    without.startsWith('[0:v]format=rgba,chromakey='),
    `filter must start with format=rgba when there is no crop, got: ${without.slice(0, 60)}`,
  );
});

test('presenterSpriteArgs: rejects invalid crop values', () => {
  const base: PresenterSpriteOptions = { image: SPRITE, out: '/tmp/out.png', state: 'open' };
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: -1, y: 0, w: 10, h: 10 } }), /crop/, 'negative x');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 0, y: -1, w: 10, h: 10 } }), /crop/, 'negative y');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 10, h: 10.5 } }), /crop/, 'fractional h');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 1.5, y: 0, w: 10, h: 10 } }), /crop/, 'fractional x');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 0, h: 10 } }), /crop/, 'zero width');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 10, h: 0 } }), /crop/, 'zero height');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 1, h: 10 } }), /crop/, 'width below 2');
  assert.throws(() => presenterSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 10, h: NaN } }), /crop/, 'NaN height');
});

test('presenterSpriteArgs: key color/similarity/blend overrides', () => {
  const filter = filterOf(
    presenterSpriteArgs({
      image: SPRITE,
      out: '/tmp/out.png',
      state: 'mid',
      keyColor: '0x00CC00',
      keySimilarity: 0.5,
      keyBlend: 0.1,
    }),
  );
  assert.match(filter, /chromakey=0x00CC00:0\.5:0\.1/);
});

test('presenterSpriteArgs: rejects invalid mouthY, drop and unknown state', () => {
  const base: PresenterSpriteOptions = { image: SPRITE, out: '/tmp/out.png', state: 'open' };
  assert.throws(() => presenterSpriteArgs({ ...base, mouthY: 0.05 }), /mouthY/);
  assert.throws(() => presenterSpriteArgs({ ...base, mouthY: 0.95 }), /mouthY/);
  assert.throws(() => presenterSpriteArgs({ ...base, mouthY: NaN }), /mouthY/);
  assert.throws(() => presenterSpriteArgs({ ...base, drop: 0 }), /drop/);
  assert.throws(() => presenterSpriteArgs({ ...base, drop: 0.5 }), /drop/);
  assert.throws(() => presenterSpriteArgs({ ...base, state: 'gaping' as never }), /state/);
});

test('presenterConcatList: merges consecutive equal states into runs', () => {
  const sprites = {
    closed: '/tmp/sprites/closed.png',
    mid: '/tmp/sprites/mid.png',
    open: '/tmp/sprites/open.png',
  };
  const list = presenterConcatList(['closed', 'closed', 'open', 'open', 'open', 'mid'], sprites);
  const lines = list.trimEnd().split('\n');
  assert.deepEqual(lines, [
    `file '${sprites.closed}'`,
    'duration 0.083333',
    `file '${sprites.open}'`,
    'duration 0.125',
    `file '${sprites.mid}'`,
    'duration 0.041667',
    `file '${sprites.mid}'`, // concat demuxer ignores the last duration: repeat the last file
  ]);
});

test('presenterConcatList: custom fps and quote escaping', () => {
  const path = '/tmp/sprites/it\'s.png';
  const list = presenterConcatList(['open'], { closed: 'c', mid: 'm', open: path }, 12);
  assert.match(list, /file '\/tmp\/sprites\/it'\\''s\.png'/);
  assert.match(list, /duration 0\.083333/, '1 state at 12fps = 1/12s');
});

test('presenterConcatList: empty states is a hard error', () => {
  assert.throws(
    () => presenterConcatList([], { closed: 'c', mid: 'm', open: 'o' }),
    /at least one/,
  );
});

test('presenterClipArgs: exact default args, qtrle + alpha vf + frame count', () => {
  assert.deepEqual(presenterClipArgs({ listFile: '/tmp/list.txt', out: '/tmp/clip.mov', frames: 221 }), [
    '-f', 'concat', '-safe', '0', '-i', '/tmp/list.txt',
    '-vf', 'fps=24,format=argb', '-c:v', 'qtrle', '-frames:v', '221', '/tmp/clip.mov',
  ]);
});

test('presenterClipArgs: frames lands just before the output path', () => {
  const args = presenterClipArgs({ listFile: 'l', out: 'o.mov', frames: 221 });
  const i = args.indexOf('-frames:v');
  assert.notEqual(i, -1, 'args must contain -frames:v');
  assert.equal(args[i + 1], '221');
  assert.equal(args[i + 2], 'o.mov', 'output path is right after the frame count');
});

test('presenterClipArgs: custom fps still shows in the -vf alongside frames', () => {
  const args = presenterClipArgs({ listFile: 'l', out: 'o.mov', fps: 30, frames: 42 });
  assert.equal(args[args.indexOf('-vf') + 1], 'fps=30,format=argb');
  assert.equal(args[args.indexOf('-frames:v') + 1], '42');
});

test('presenterClipArgs: frames is required and a positive integer', () => {
  assert.throws(() => presenterClipArgs({ listFile: 'l', out: 'o.mov', frames: 0 }), /frames/);
  assert.throws(() => presenterClipArgs({ listFile: 'l', out: 'o.mov', frames: -3 }), /frames/);
  assert.throws(() => presenterClipArgs({ listFile: 'l', out: 'o.mov', frames: 1.5 }), /frames/);
  assert.throws(() => presenterClipArgs({ listFile: 'l', out: 'o.mov', frames: NaN }), /frames/);
  assert.throws(() => presenterClipArgs({ listFile: 'l', out: 'o.mov' } as never), /frames/);
});

const overlayBase = { video: VIDEO, clipA: CLIP_A, clipB: CLIP_B, out: OUT };

test('presenterOverlayArgs: defaults for 720p place A bottom-left, B bottom-right', () => {
  const args = presenterOverlayArgs({ ...overlayBase, videoHeight: 720 });
  const filter = filterOf(args);
  assert.equal(filter,
    '[1:v]scale=-2:288[a];' +
    '[2:v]scale=-2:288[b];' +
    '[0:v][a]overlay=x=14:y=main_h-overlay_h-14:eof_action=pass:format=auto[t];' +
    '[t][b]overlay=x=main_w-overlay_w-14:y=main_h-overlay_h-14:eof_action=pass:format=auto[v]');
  assert.deepEqual(args.slice(0, 6), ['-i', VIDEO, '-i', CLIP_A, '-i', CLIP_B], 'inputs in order: video, clipA, clipB');

  const x264 = args.filter((a) => a === 'libx264');
  assert.equal(x264.length, 1, 'exactly one libx264 pass');
  assert.equal(args[args.indexOf('-crf') + 1], String(VIDEO_CRF), '-crf equals VIDEO_CRF');
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'cfr', 'constant frame rate: the default vfr mode drops frames whose timestamps collide after the overlay');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy', 'audio copied');
  assert.ok(args.includes('0:a?'), 'optional audio map present');
  assert.equal(args.at(-1), OUT, 'output path last');
});

test('presenterOverlayArgs: 1280 vertical with custom ratios has zero margin', () => {
  const filter = filterOf(presenterOverlayArgs({ ...overlayBase, videoHeight: 1280, heightRatio: 0.3, marginRatio: 0 }));
  assert.match(filter, /scale=-2:384\[a\]/);           // H = 2 * round(1280*0.3/2) = 384
  assert.match(filter, /scale=-2:384\[b\]/);
  assert.match(filter, /overlay=x=0:y=main_h-overlay_h-0/);
  assert.match(filter, /overlay=x=main_w-overlay_w-0:y=main_h-overlay_h-0/);
});

test('presenterOverlayArgs: odd scaled height rounds to an even value', () => {
  // 500 * 0.35 = 175 (odd) -> 2 * Math.round(175/2) = 176
  const filter = filterOf(presenterOverlayArgs({ ...overlayBase, videoHeight: 500, heightRatio: 0.35 }));
  assert.match(filter, /scale=-2:176\[a\]/);
  assert.match(filter, /scale=-2:176\[b\]/);
  assert.ok(!/scale=-2:175\b/.test(filter), 'odd height must not appear');
});

test('presenterOverlayArgs: rejects invalid videoHeight, heightRatio and marginRatio', () => {
  const bad = (patch: Partial<PresenterOverlayOptions>) => () => presenterOverlayArgs({ video: VIDEO, clipA: CLIP_A, clipB: CLIP_B, out: OUT, videoHeight: 720, ...patch });
  assert.throws(bad({ videoHeight: 0 }), /videoHeight/);
  assert.throws(bad({ videoHeight: 720.5 }), /videoHeight/);
  assert.throws(bad({ videoHeight: -10 }), /videoHeight/);
  assert.throws(bad({ heightRatio: 0.05 }), /heightRatio/);
  assert.throws(bad({ heightRatio: 1 }), /heightRatio/);
  assert.throws(bad({ marginRatio: -0.1 }), /marginRatio/);
  assert.throws(bad({ marginRatio: 0.5 }), /marginRatio/);
});

// -- presenterMouthSpriteArgs: mouth drawn inside the lip box ----------------------------------------------

const MOUTH = { x: 330, y: 470, w: 230, h: 120 };

test('presenterMouthSpriteArgs: closed has no ellipse sources, mid one, open two', () => {
  const count = (state: 'closed' | 'mid' | 'open') => {
    const args = presenterMouthSpriteArgs({ image: SPRITE, out: `/tmp/m_${state}.png`, state, mouth: MOUTH });
    assert.deepEqual(args.slice(0, 2), ['-i', SPRITE]);
    assert.deepEqual(args.slice(-3), ['-frames:v', '1', `/tmp/m_${state}.png`]);
    const f = filterOf(args);
    assert.match(f, /chromakey=0x00FF00:0\.06:0\.02/);
    return (f.match(/color=c=/g) ?? []).length;
  };
  assert.equal(count('closed'), 0);
  assert.equal(count('mid'), 1);
  assert.equal(count('open'), 2);
});

test('presenterMouthSpriteArgs: ellipse sizes and offsets derive from the lip box', () => {
  const mid = filterOf(presenterMouthSpriteArgs({ image: SPRITE, out: '/tmp/o.png', state: 'mid', mouth: MOUTH }));
  // 0.62*230 = 143 (142.6), 0.34*120 = 41 (40.8); centred: x 330+round((230-143)/2)=374 (43.5 -> 44 => 374), y 470+round((120-41)/2)
  assert.ok(mid.includes('s=143x41'), mid);
  assert.match(mid, /overlay=374:510/);
  const open = filterOf(presenterMouthSpriteArgs({ image: SPRITE, out: '/tmp/o.png', state: 'open', mouth: MOUTH }));
  assert.ok(open.includes('s=161x86'), open); // 0.70*230=161, 0.72*120=86.4
  assert.ok(open.includes('s=97x26'), open); // tongue 0.42*230=96.6, 0.22*120=26.4
});

test('presenterMouthSpriteArgs: crop is applied first and subtracted from the mouth coordinates', () => {
  const crop = { x: 198, y: 132, w: 622, h: 720 };
  const a = filterOf(presenterMouthSpriteArgs({ image: SPRITE, out: '/tmp/o.png', state: 'mid', mouth: MOUTH }));
  const b = filterOf(presenterMouthSpriteArgs({ image: SPRITE, out: '/tmp/o.png', state: 'mid', mouth: MOUTH, crop }));
  assert.ok(b.startsWith('[0:v]crop=622:720:198:132,format=rgba'), b);
  assert.match(a, /overlay=374:510/);
  assert.match(b, /overlay=176:378/); // 374-198, 510-132
});

test('presenterMouthSpriteArgs: key overrides land in the filter', () => {
  const f = filterOf(
    presenterMouthSpriteArgs({ image: SPRITE, out: '/tmp/o.png', state: 'closed', mouth: MOUTH, keyColor: '0x3ad637', keySimilarity: 0.1, keyBlend: 0.05 }),
  );
  assert.match(f, /chromakey=0x3ad637:0\.1:0\.05/);
});

test('presenterMouthSpriteArgs: validation errors', () => {
  const base = { image: SPRITE, out: '/tmp/o.png', state: 'open' as const, mouth: MOUTH };
  assert.throws(() => presenterMouthSpriteArgs({ ...base, state: 'wide' as never }), /state must be/);
  assert.throws(() => presenterMouthSpriteArgs({ ...base, mouth: { ...MOUTH, w: 1 } }), /mouth must use/);
  assert.throws(() => presenterMouthSpriteArgs({ ...base, mouth: { ...MOUTH, x: -1 } }), /mouth must use/);
  assert.throws(() => presenterMouthSpriteArgs({ ...base, mouth: { ...MOUTH, y: 1.5 } }), /mouth must use/);
  assert.throws(() => presenterMouthSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 1, h: 10 } }), /crop must use/);
  assert.throws(
    () => presenterMouthSpriteArgs({ ...base, crop: { x: 400, y: 0, w: 300, h: 900 } }),
    /mouth box must fall inside the crop/,
  );
  assert.throws(
    () => presenterMouthSpriteArgs({ ...base, crop: { x: 0, y: 0, w: 500, h: 500 } }),
    /mouth box must fall inside the crop/,
  );
});
