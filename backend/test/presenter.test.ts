import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  presenterSpriteArgs,
  presenterConcatList,
  presenterClipArgs,
  type PresenterSpriteOptions,
} from '../src/media/ffmpeg.js';

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
    assert.match(filter, /chromakey=0x00FF00:0\.28:0\.08/, `chromakey defaults for ${state}`);
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
