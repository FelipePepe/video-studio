import * as assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { cacheConfigFromEnv, ContentCache, resolveCacheDir, startCachePruning } from '../src/pipeline/contentCache';

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

// ---- B9 integrity ----
const mk = () => mkdtempSync(join(tmpdir(), 'vscache-b-'));
const tmps = (d: string) => readdirSync(d).filter((f) => f.endsWith('.tmp'));

test('store is atomic: a failing rename leaves no .tmp and no partial final file', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    const k = c.key(1, 'blocked');
    // A non-empty directory under the final name makes the rename fail portably.
    mkdirSync(c.filePath(k));
    writeFileSync(join(c.filePath(k), 'x'), 'x');
    assert.throws(() => c.store(k, Buffer.from('data')));
    assert.deepEqual(tmps(d), []);
    assert.ok(statSync(c.filePath(k)).isDirectory(), 'final path untouched');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('store leaves no .tmp behind on success', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    c.store('k1', Buffer.from('abc'));
    assert.deepEqual(readdirSync(d), ['k1']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('storeFile copies bytes via a temp name and leaves no .tmp', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    const src = join(d, 'src.bin');
    writeFileSync(src, Buffer.from([1, 2, 3, 4]));
    c.storeFile('k2', src);
    assert.deepEqual(readFileSync(c.filePath('k2')), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(tmps(d), []);
    assert.throws(() => c.storeFile('k3', join(d, 'missing')));
    assert.deepEqual(tmps(d), []);
    assert.equal(c.has('k3'), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('copyTo returns false for a missing key and refreshes mtime on a hit', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    const dest = join(d, 'out.bin');
    assert.equal(c.copyTo('nope', dest), false);
    c.store('hit', Buffer.from('zzz'));
    const old = new Date(Date.now() - 10 * 24 * 3600_000);
    utimesSync(c.filePath('hit'), old, old);
    assert.equal(c.copyTo('hit', dest), true);
    assert.equal(readFileSync(dest, 'utf8'), 'zzz');
    assert.ok(Date.now() - statSync(c.filePath('hit')).mtimeMs < 60_000, 'mtime refreshed');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('copyTo rethrows errors other than ENOENT', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    c.store('hit', Buffer.from('zzz'));
    assert.throws(() => c.copyTo('hit', join(d, 'no-such-dir', 'out.bin')));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---- B8 retention ----
const NOW = Date.parse('2026-10-24T12:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
function put(d: string, name: string, bytes: number, ageMs: number): void {
  const p = join(d, name);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  const t = new Date(NOW - ageMs);
  utimesSync(p, t, t);
}

test('prune removes entries older than maxAgeMs and reports counts', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    put(d, 'old', 100, 40 * DAY);
    put(d, 'new', 50, 1 * DAY);
    const r = c.prune({ maxAgeMs: 30 * DAY, now: NOW });
    assert.deepEqual(r, { removed: 1, freedBytes: 100, remainingBytes: 50 });
    assert.deepEqual(readdirSync(d), ['new']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('prune by size removes least-recently-used first and stops at the limit', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    put(d, 'a', 100, 3 * DAY);
    put(d, 'b', 100, 2 * DAY);
    put(d, 'c', 100, 1 * DAY);
    const r = c.prune({ maxBytes: 250, now: NOW });
    assert.deepEqual(readdirSync(d).sort(), ['b', 'c']);
    assert.deepEqual(r, { removed: 1, freedBytes: 100, remainingBytes: 200 });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('prune removes stale .tmp (> 1 h) but keeps a fresh one', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    put(d, 'x.1.aa.tmp', 10, 2 * HOUR);
    put(d, 'y.1.bb.tmp', 10, 5 * 60_000);
    c.prune({ now: NOW });
    assert.deepEqual(readdirSync(d), ['y.1.bb.tmp']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('prune with no limits keeps fresh entries', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    put(d, 'a', 10, 100 * DAY);
    assert.equal(c.prune({ now: NOW }).removed, 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('prune never throws and continues past a file that cannot be removed', () => {
  const d = mk();
  try {
    const c = new ContentCache(d);
    // A non-empty directory cannot be unlinked as a file; it must be skipped, not abort the prune.
    mkdirSync(join(d, 'adir'));
    writeFileSync(join(d, 'adir', 'f'), 'f');
    const t = new Date(NOW - 90 * DAY);
    utimesSync(join(d, 'adir'), t, t);
    put(d, 'old', 10, 90 * DAY);
    let r: ReturnType<ContentCache['prune']> | undefined;
    assert.doesNotThrow(() => {
      r = c.prune({ maxAgeMs: 30 * DAY, now: NOW });
    });
    assert.equal(existsSync(join(d, 'old')), false);
    assert.equal(r?.removed, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('prune on a vanished directory does not throw', () => {
  const d = mk();
  const c = new ContentCache(d);
  rmSync(d, { recursive: true, force: true });
  assert.deepEqual(c.prune({ maxAgeMs: 1, now: NOW }), { removed: 0, freedBytes: 0, remainingBytes: 0 });
});

test('cacheConfigFromEnv: defaults, overrides, and lenient invalid values', () => {
  assert.deepEqual(cacheConfigFromEnv({}), { maxAgeMs: 30 * DAY, maxBytes: 20 * 1024 ** 3 });
  assert.deepEqual(cacheConfigFromEnv({ CACHE_TTL_DAYS: '7', CACHE_MAX_GB: '1.5' }), {
    maxAgeMs: 7 * DAY,
    maxBytes: 1.5 * 1024 ** 3,
  });
  for (const bad of ['', '  ', 'abc', '0', '-3']) {
    assert.deepEqual(cacheConfigFromEnv({ CACHE_TTL_DAYS: bad, CACHE_MAX_GB: bad }), { maxAgeMs: 30 * DAY, maxBytes: 20 * 1024 ** 3 }, `invalid ${JSON.stringify(bad)}`);
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
}

test('startCachePruning prunes immediately, re-prunes on interval, and stop() clears the timer', async () => {
  const d = mk();
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(`i:${m}`), warn: (m: string) => logs.push(`w:${m}`) };
  const config = { maxAgeMs: 30 * DAY, maxBytes: 1024 ** 3 };
  try {
    put(d, 'old1', 10, 90 * DAY);
    const h = startCachePruning({ dir: d, config, log, intervalMs: 20, now: () => NOW });
    try {
      assert.equal(existsSync(join(d, 'old1')), false, 'pruned synchronously at start');
      assert.ok(logs.some((l) => l.startsWith('i:')), 'logs when something was removed');
      put(d, 'old2', 10, 90 * DAY);
      await until(() => !existsSync(join(d, 'old2')));
      assert.equal(existsSync(join(d, 'old2')), false, 'pruned again on interval');
    } finally {
      h.stop();
    }
    put(d, 'old3', 10, 90 * DAY);
    await sleep(80);
    assert.equal(existsSync(join(d, 'old3')), true, 'no prune after stop()');
    h.stop(); // idempotent
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('startCachePruning logs a warning and keeps running when the prune throws', () => {
  const logs: string[] = [];
  const log = { info: () => {}, warn: (m: string) => logs.push(m) };
  const h = startCachePruning({
    dir: mk(),
    config: { maxAgeMs: 1, maxBytes: 1 },
    log,
    intervalMs: 3_600_000,
    now: () => {
      throw new Error('clock exploded');
    },
  });
  h.stop();
  assert.equal(logs.length, 1);
});

test('resolveCacheDir resolves the default and an override to absolute paths', () => {
  assert.ok(isAbsolute(resolveCacheDir()));
  assert.ok(resolveCacheDir().endsWith(join('data', 'cache')));
  assert.equal(resolveCacheDir('/x/y'), '/x/y');
});
