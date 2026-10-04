import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';
import { resolveEffectiveConfig, updateSettings, loadEnvDefaults } from '../src/config/settings';

test('file-backed DB persists settings across reopen and uses WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-studio-'));
  try {
    const file = join(dir, 'test.sqlite');
    const envDefaults = loadEnvDefaults({});
    const first = openDatabase(file);
    const mode = first.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(mode.journal_mode, 'wal');
    updateSettings(first, { comfyHost: 'http://persisted:1' });
    first.close();

    const second = openDatabase(file);
    assert.equal(resolveEffectiveConfig(second, envDefaults).comfyHost, 'http://persisted:1');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a pre-piper database migrates kokoro_host to piper_host and drops the stale value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-studio-'));
  try {
    const file = join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE server_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      comfy_host TEXT NOT NULL DEFAULT '',
      ollama_host TEXT NOT NULL DEFAULT '',
      kokoro_host TEXT NOT NULL DEFAULT ''
    )`);
    legacy
      .prepare('INSERT INTO server_settings (id, comfy_host, kokoro_host) VALUES (1, ?, ?)')
      .run('http://old-comfy:1', 'http://localhost:8880');
    legacy.close();

    const envDefaults = loadEnvDefaults({});
    const migrated = openDatabase(file);
    const columns = (migrated.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    assert.ok(columns.includes('piper_host'));
    assert.ok(!columns.includes('kokoro_host'));

    const config = resolveEffectiveConfig(migrated, envDefaults);
    assert.equal(config.comfyHost, 'http://old-comfy:1');
    assert.equal(config.piperHost, envDefaults.piperHost);
    updateSettings(migrated, { piperHost: 'tcp://piper:10200' });
    migrated.close();

    const reopened = openDatabase(file);
    assert.equal(resolveEffectiveConfig(reopened, envDefaults).piperHost, 'tcp://piper:10200');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
