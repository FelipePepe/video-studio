import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/jobs/eventHub';
import type { JobEvent } from '../src/jobs/types';

const ev = (jobId: string, n: number): JobEvent => ({ type: 'progress', jobId, progress: n, at: 'now' });

test('subscribers receive published events for their job only', () => {
  const hub = new EventHub();
  const a: JobEvent[] = [];
  const b: JobEvent[] = [];
  hub.subscribe('a', (e) => a.push(e));
  hub.subscribe('b', (e) => b.push(e));
  hub.publish(ev('a', 1));
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
});

test('unsubscribe stops delivery', () => {
  const hub = new EventHub();
  const got: JobEvent[] = [];
  const off = hub.subscribe('a', (e) => got.push(e));
  hub.publish(ev('a', 1));
  off();
  hub.publish(ev('a', 2));
  assert.equal(got.length, 1);
  assert.equal(hub.listenerCount('a'), 0);
});

test('replay buffer is bounded to the last 200 events', () => {
  const hub = new EventHub();
  for (let i = 0; i < 250; i++) hub.publish(ev('a', i));
  const replay = hub.replay('a');
  assert.equal(replay.length, 200);
  assert.equal(replay[0].progress, 50);
  assert.equal(replay[199].progress, 249);
});

test('stage events are pinned in the replay buffer: a flood of progress ticks never evicts them', () => {
  const hub = new EventHub();
  const stage = (s: string, p: number): JobEvent => ({ type: 'stage', jobId: 'a', stage: s, progress: p, at: 'now' });
  hub.publish(stage('tts', 0.25));
  for (let i = 0; i < 250; i++) hub.publish(ev('a', 0.26 + i / 1000));
  hub.publish(stage('images', 0.5));
  const replay = hub.replay('a');
  const stages = replay.filter((e) => e.type === 'stage');
  assert.deepEqual(
    stages.map((s) => s.stage),
    ['tts', 'images'],
    'reconnecting clients must still see the stage context after the replay window fills with ticks');
  assert.equal(replay.length, 200, 'the buffer still never exceeds replaySize: 198 ticks + 2 pinned stages');
});

test('replay of an unknown job is empty', () => {
  assert.deepEqual(new EventHub().replay('x'), []);
});

test('clear drops the buffer and listeners', () => {
  const hub = new EventHub();
  const got: JobEvent[] = [];
  hub.subscribe('a', (e) => got.push(e));
  hub.publish(ev('a', 1));
  hub.clear('a');
  assert.deepEqual(hub.replay('a'), []);
  hub.publish(ev('a', 2));
  assert.equal(got.length, 1);
});

test('a throwing listener does not stop the others', () => {
  const hub = new EventHub();
  const got: JobEvent[] = [];
  hub.subscribe('a', () => {
    throw new Error('bad listener');
  });
  hub.subscribe('a', (e) => got.push(e));
  hub.publish(ev('a', 1));
  assert.equal(got.length, 1);
});
