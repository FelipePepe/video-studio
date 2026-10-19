import { test } from 'node:test';
import * as assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planRetention,
  pruneWorkDirs,
  retentionConfigFromEnv,
  type RetentionJob,
} from '../src/jobs/retention';

const NOW = Date.parse('2026-10-19T00:00:00Z');
const day = 24 * 3600 * 1000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * day).toISOString();

test('planRetention keeps active, recent-N, and unknown ids; prunes old finished', () => {
  const jobs: RetentionJob[] = [
    { id: 'queued', status: 'queued', finishedAt: null },
    { id: 'running', status: 'running', finishedAt: null },
    { id: 'fresh1', status: 'done', finishedAt: iso(-1) },
    { id: 'fresh2', status: 'done', finishedAt: iso(-6) },
    { id: 'old1', status: 'done', finishedAt: iso(-8) },
    { id: 'old2', status: 'failed', finishedAt: iso(-9) },
    { id: 'unfinished', status: 'done', finishedAt: null },
  ];
  const cfg = { keepRecent: 2, minAgeMs: 7 * day };
  const pruned = planRetention(jobs.map((j) => j.id), jobs, cfg, NOW).sort();
  assert.deepEqual(pruned, ['old1', 'old2']);
});

test('planRetention: default config keeps everything if within keepRecent', () => {
  const jobs: RetentionJob[] = [
    { id: 'a', status: 'done', finishedAt: iso(-30) },
    { id: 'b', status: 'done', finishedAt: iso(-60) },
    { id: 'c', status: 'done', finishedAt: iso(-90) },
  ];
  // Default keepRecent (10) covers all three → nothing to prune even though old.
  assert.deepEqual(planRetention(jobs.map((j) => j.id), jobs, {}, NOW), []);
});

test('planRetention never prunes an id it is not aware of (defensive)', () => {
  const jobs: RetentionJob[] = [{ id: 'known', status: 'done', finishedAt: iso(-90) }];
  const pruned = planRetention(['orphan', 'known'], jobs, { keepRecent: 0, minAgeMs: 7 * day }, NOW);
  assert.ok(!pruned.includes('orphan'), 'unknown id is never pruned');
  assert.ok(pruned.includes('known'), 'known old job is pruned');
});

test('pruneWorkDirs removes only the planned job directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'vs-ret-'));
  try {
    for (const id of ['keep', 'del']) mkdirSync(join(base, id), { recursive: true });
    const jobs: RetentionJob[] = [
      { id: 'keep', status: 'done', finishedAt: iso(-1) },
      { id: 'del', status: 'done', finishedAt: iso(-30) },
      { id: 'no-dir', status: 'done', finishedAt: iso(-40) },
    ];
    const { pruned } = pruneWorkDirs(base, jobs, { keepRecent: 1, minAgeMs: 7 * day }, NOW);
    assert.deepEqual(pruned, ['del']);
    assert.equal(existsSync(join(base, 'del')), false, 'planned dir was removed');
    assert.equal(existsSync(join(base, 'keep')), true, 'recent dir kept');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('retentionConfigFromEnv parses days and keep count', () => {
  const cfg = retentionConfigFromEnv({ RETENTION_MIN_AGE_DAYS: '3', RETENTION_KEEP_RECENT: '5' });
  assert.equal(cfg.minAgeMs, 3 * 24 * 3600 * 1000);
  assert.equal(cfg.keepRecent, 5);
  assert.deepEqual(retentionConfigFromEnv({}), {});
});
