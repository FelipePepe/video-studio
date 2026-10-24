import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChapters } from '../src/pipeline/chapters';
import type { Escaleta } from '../src/pipeline/types';

const esc = (titles: string[]): Escaleta =>
  titles.map((title, i) => ({ scene: i, title, narration: `n${i}`, visualPrompt: 'v', voice: 'male' as const }));

test('chapters start at zero and accumulate narration durations', () => {
  const ch = buildChapters(esc(['A', 'B', 'C']), [2, 3, 4], 0, () => false);
  assert.equal(ch.length, 3);
  assert.equal(ch[0].startSec, 0);
  assert.equal(ch[0].durationSec, 2);
  assert.equal(ch[1].startSec, 2);
  assert.equal(ch[1].durationSec, 3);
  assert.equal(ch[2].startSec, 5);
  assert.equal(ch[2].durationSec, 4);
  assert.deepEqual(ch.map((c) => c.title), ['A', 'B', 'C']);
  assert.deepEqual(ch.map((c) => c.index), [0, 1, 2]);
});

test('interleaved I2V transitions shift subsequent chapter starts', () => {
  // [narrA][trans][narrB]  — transition of 3s after A.
  const ch = buildChapters(esc(['A', 'B']), [2, 4], 3, (i) => i === 0);
  assert.equal(ch[0].startSec, 0);
  assert.equal(ch[1].startSec, 5); // 2 (A) + 3 (transition)
  assert.equal(ch[1].durationSec, 4);
});

test('zero-duration or missing-duration scenes still emit a chapter', () => {
  const ch = buildChapters(esc(['A']), [], 0, () => false);
  assert.equal(ch[0].durationSec, 0);
  assert.equal(ch[0].startSec, 0);
});

test('single-scene escaleta is one chapter', () => {
  const ch = buildChapters(esc(['Solo']), [1.5], 3, () => false);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].startSec, 0);
  assert.equal(ch[0].durationSec, 1.5);
});
