import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
