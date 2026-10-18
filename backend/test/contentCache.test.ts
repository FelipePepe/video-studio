import * as assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContentCache } from '../src/pipeline/contentCache';

const dir = mkdtempSync(join(tmpdir(), 'vscache-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('key is deterministic, distinguishes inputs, and is invalidated by a version bump', () => {
  const c = new ContentCache(dir);
  const k = c.key(1, 'narration', 'voice-a');
  assert.equal(k, c.key(1, 'narration', 'voice-a'));
  assert.notEqual(c.key(1, 'narration', 'voice-a'), c.key(1, 'other', 'voice-a'));
  assert.notEqual(c.key(1, 'narration', 'voice-a'), c.key(2, 'narration', 'voice-a'), 'version bump must invalidate');
  assert.match(k, /^[0-9a-f]{64}$/, 'a sha256 hex key');
  for (const field of [undefined, null, 0, false] as const) {
    assert.doesNotThrow(() => c.key(1, field));
  }
});

test('store / has / read round-trips an artifact byte-for-byte', () => {
  const c = new ContentCache(dir);
  const k = c.key(1, 'scene-1');
  assert.equal(c.has(k), false);
  const data = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // RIFF...
  c.store(k, Buffer.from(data));
  assert.equal(c.has(k), true);
  assert.ok(c.read(k).equals(Buffer.from(data)), 'read() returns the stored bytes');
  assert.deepEqual(readFileSync(c.filePath(k)), data);
});

test('distinct scene contents produce distinct cache entries (no cross-talk)', () => {
  const c = new ContentCache(dir);
  const a = c.key(1, 'first', 'voice');
  const b = c.key(1, 'second', 'voice');
  c.store(a, Buffer.from('AAA'));
  assert.equal(c.has(a), true);
  assert.equal(c.has(b), false);
  assert.equal(c.read(a).toString(), 'AAA');
});
