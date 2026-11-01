import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NORMALIZED_MID_THRESHOLD,
  NORMALIZED_OPEN_THRESHOLD,
  mouthStates,
  presenterTimelines,
  type MouthState,
} from '../src/media/audioEnvelope';
import { wavFromPcm, type PcmFormat } from '../src/media/wav';

const FMT: PcmFormat = { rate: 16000, width: 2, channels: 1 };
const FMT_STEREO: PcmFormat = { rate: 16000, width: 2, channels: 2 };

/** Build a 16-bit mono WAV from a list of segments; amplitude is 0..1 full scale. */
function tone(segments: Array<{ amp: number; sec: number }>): Buffer {
  let pcm = Buffer.alloc(0);
  for (const seg of segments) {
    const n = Math.round(seg.sec * FMT.rate);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(seg.amp * 32768), i * 2);
    pcm = Buffer.concat([pcm, buf]);
  }
  return wavFromPcm(pcm, FMT);
}

function statesOf(wav: Buffer): MouthState[] {
  return mouthStates(wav);
}

test('silence -> all closed, length ceil(sec*24)', () => {
  const wav = tone([{ amp: 0, sec: 0.5 }]);
  const states = statesOf(wav);
  assert.equal(states.length, Math.ceil(0.5 * 24)); // 12
  assert.ok(states.every((s) => s === 'closed'), `expected all closed, got ${JSON.stringify(states)}`);
});

test('empty data chunk -> []', () => {
  const wav = wavFromPcm(Buffer.alloc(0), FMT);
  assert.deepEqual(statesOf(wav), []);
});

test('constant loud tone -> mostly open after the first frame, never closed in the middle', () => {
  const wav = tone([{ amp: 0.5, sec: 1 }]); // sine/DC at 0.5 fs -> RMS ~0.35+, well above 0.12
  const states = statesOf(wav);
  assert.equal(states.length, 24);
  assert.equal(states[0], 'open');
  const middle = states.slice(1, -1);
  assert.ok(middle.length > 0);
  assert.ok(middle.every((s) => s === 'open'), `expected all open in the middle, got ${JSON.stringify(states)}`);
  assert.ok(!states.includes('closed'), `no frame should be closed, got ${JSON.stringify(states)}`);
});

test('quiet tone -> mid (above mid threshold, below open threshold)', () => {
  const wav = tone([{ amp: 0.08, sec: 0.5 }]); // RMS ~0.08 > 0.04, < 0.12
  const states = statesOf(wav);
  assert.ok(states.length >= 10);
  const middle = states.slice(1, -1);
  assert.ok(middle.every((s) => s === 'mid'), `expected all mid in the middle, got ${JSON.stringify(states)}`);
  assert.ok(!states.includes('open'), `quiet tone must never reach open, got ${JSON.stringify(states)}`);
});

test('burst pattern -> open ... closed ... open', () => {
  const wav = tone([
    { amp: 0.5, sec: 0.5 },
    { amp: 0, sec: 0.5 },
    { amp: 0.5, sec: 0.5 },
  ]);
  const states = statesOf(wav);
  assert.equal(states.length, 36);
  assert.equal(states[3], 'open');
  assert.equal(states[18], 'closed');
  assert.equal(states[33], 'open');
});

test('hysteresis: hovering just under the open threshold while previously open does not flicker', () => {
  // Loud (open) -> signal drops to 0.11 RMS: below openThreshold (0.12) but above
  // 0.7*0.12 = 0.084, so a DOWN move is not permitted -> must stay open, no flicker.
  const wav = tone([
    { amp: 0.5, sec: 0.5 },
    { amp: 0.11, sec: 0.5 },
  ]);
  const states = statesOf(wav);
  assert.equal(states.length, 24);
  assert.ok(states.slice(0, 12).every((s) => s === 'open'), `loud region must be open, got ${JSON.stringify(states)}`);
  assert.ok(states.slice(12).every((s) => s === 'open'), `hover frames must stay open, got ${JSON.stringify(states)}`);
});

test('fps option changes the frame count (12 fps -> half the frames)', () => {
  const wav = tone([{ amp: 0.5, sec: 1 }]);
  assert.equal(mouthStates(wav).length, 24);
  assert.equal(mouthStates(wav, { fps: 12 }).length, Math.ceil(1 * 12));
  assert.equal(mouthStates(wav, { fps: 30 }).length, Math.ceil(1 * 30));
});

test('custom thresholds are honoured', () => {
  // 0.11 RMS is 'open' when openThreshold is lowered but stays 'mid' at the default.
  const wav = tone([{ amp: 0.11, sec: 0.5 }]);
  assert.ok(mouthStates(wav).every((s) => s === 'closed' || s === 'mid'));
  const loudened = mouthStates(wav, { openThreshold: 0.05 });
  assert.ok(loudened.slice(1, -1).every((s) => s === 'open'));
});

test('8-bit (or non-16-bit) WAV throws', () => {
  const wav = wavFromPcm(Buffer.alloc(16000), { rate: 16000, width: 1, channels: 1 });
  assert.throws(() => mouthStates(wav), /16-bit/i);
});

test('stereo: only the first channel is read', () => {
  const n = 8000; // 0.5 s
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(0.5 * 32768), i * 4); // L: loud
    pcm.writeInt16LE(0, i * 4 + 2); // R: silent
  }
  const wav = wavFromPcm(pcm, FMT_STEREO);
  const states = mouthStates(wav);
  assert.equal(states.length, 12);
  assert.ok(states.slice(1, -1).every((s) => s === 'open'), `expected open from the left channel, got ${JSON.stringify(states)}`);
});

test('normalize: exported default fractions', () => {
  assert.equal(NORMALIZED_MID_THRESHOLD, 0.22);
  assert.equal(NORMALIZED_OPEN_THRESHOLD, 0.8);
});

test('normalize: a clip and the same clip scaled by 0.4x give the SAME state sequence; without normalisation they differ', () => {
  const blocks = (a: number) => [
    { amp: a, sec: 0.3 }, // loud
    { amp: a * 0.3, sec: 0.2 }, // quiet
    { amp: 0, sec: 0.2 }, // silence
    { amp: a, sec: 0.3 }, // loud
    { amp: a * 0.3, sec: 0.2 }, // quiet
    { amp: 0, sec: 0.2 }, // silence
  ];
  const full = tone(blocks(0.5));
  const scaled = tone(blocks(0.2));
  const normFull = mouthStates(full, { normalize: true });
  const normScaled = mouthStates(scaled, { normalize: true });
  assert.deepEqual(normScaled, normFull, 'normalised sequences must be scale-invariant');
  assert.ok(normFull.includes('open'), 'should still reach open, got ' + JSON.stringify(normFull));
  assert.ok(normFull.includes('mid'), 'should reach mid, got ' + JSON.stringify(normFull));
  assert.ok(normFull.includes('closed'), 'should include closed, got ' + JSON.stringify(normFull));
  assert.notDeepEqual(mouthStates(full), mouthStates(scaled), 'absolute thresholds must differ per loudness');
});

test('normalize: pure silence and near-silent noise -> all closed', () => {
  const silent = mouthStates(tone([{ amp: 0, sec: 0.5 }]), { normalize: true });
  assert.ok(silent.length > 0 && silent.every((s) => s === 'closed'));
  const noise = mouthStates(tone([{ amp: 0.002, sec: 0.5 }]), { normalize: true });
  assert.ok(noise.every((s) => s === 'closed'), `near-silent noise must be all closed, got ${JSON.stringify(noise)}`);
});

test('normalize: explicit thresholds are fractions of the p95 reference', () => {
  // p95 of the per-frame RMS is ~0.4 (the loud block); 0.2 = 0.5 * 0.4 -> 'mid' (0.3 <= 0.5 < 0.8).
  const wav = tone([
    { amp: 0.4, sec: 0.75 },
    { amp: 0.2, sec: 0.75 },
    { amp: 0, sec: 0.75 },
  ]);
  const states = mouthStates(wav, { normalize: true, midThreshold: 0.3, openThreshold: 0.8 });
  assert.ok(states.slice(4, 14).every((s) => s === 'open'), `loud block must be open, got ${JSON.stringify(states)}`);
  assert.ok(states.slice(20, 30).every((s) => s === 'mid'), `mid block must be mid, got ${JSON.stringify(states)}`);
  assert.ok(states.slice(40).every((s) => s === 'closed'), `silence must be closed, got ${JSON.stringify(states)}`);
});

test('presenterTimelines: A then B with gaps -> equal lengths, silence for the non-speaker', () => {
  const out = presenterTimelines([
    { speaker: 'A', states: ['open', 'mid', 'open'], gapFrames: 3 },
    { speaker: 'B', states: ['mid'], gapFrames: 0 },
  ]);
  assert.equal(out.A.length, 7);
  assert.equal(out.B.length, 7);
  assert.deepEqual(out.A, ['open', 'mid', 'open', 'closed', 'closed', 'closed', 'closed']);
  assert.deepEqual(out.B, ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'mid']);
});

test('presenterTimelines: scene without speaker is treated as A', () => {
  const out = presenterTimelines([
    { states: ['mid', 'open'], gapFrames: 2 },
    { speaker: 'B', states: ['open'], gapFrames: 1 },
  ]);
  assert.equal(out.A.length, out.B.length);
  assert.deepEqual(out.A, ['mid', 'open', 'closed', 'closed', 'closed', 'closed']);
  assert.deepEqual(out.B, ['closed', 'closed', 'closed', 'closed', 'open', 'closed']);
});

test('presenterTimelines: empty scene list -> empty timelines', () => {
  assert.deepEqual(presenterTimelines([]), { A: [], B: [] });
});

test('presenterTimelines: both timelines always identical length with mixed gaps', () => {
  const out = presenterTimelines([
    { speaker: 'B', states: ['open'], gapFrames: 5 },
    { speaker: 'A', states: ['open', 'open'], gapFrames: 2 },
    { states: ['mid'], gapFrames: 1 },
  ]);
  assert.equal(out.A.length, 12);
  assert.equal(out.B.length, 12);
  assert.deepEqual(out.A, ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'open', 'open', 'closed', 'closed', 'mid', 'closed']);
});
