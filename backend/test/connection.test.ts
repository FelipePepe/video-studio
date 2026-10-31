import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openDatabase, runMigrations, MIGRATIONS, type Migration } from '../src/db/connection';
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

test('a failing kokoro -> piper migration rolls back and leaves the legacy column intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-studio-'));
  try {
    const file = join(dir, 'legacy-fail.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE server_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      comfy_host TEXT NOT NULL DEFAULT '',
      ollama_host TEXT NOT NULL DEFAULT '',
      kokoro_host TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO server_settings (id, kokoro_host) VALUES (1, 'http://localhost:8880');
    CREATE TRIGGER block_update BEFORE UPDATE ON server_settings BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    legacy.close();

    assert.throws(() => openDatabase(file), /blocked/);

    const check = new DatabaseSync(file);
    const columns = (check.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    check.close();
    assert.ok(columns.includes('kokoro_host'));
    assert.ok(!columns.includes('piper_host'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const indexColumns = (db: DatabaseSync, index: string): string[] =>
  (db.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[]).map((c) => c.name);
const indexNames = (db: DatabaseSync): string[] =>
  (db.prepare('PRAGMA index_list(jobs)').all() as { name: string }[]).map((i) => i.name);
const columnNames = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test('a fresh DB is at the latest user_version and has the jobs indexes', () => {
  const db = openDatabase();
  try {
    assert.equal(userVersion(db), LATEST);
    assert.deepEqual(indexColumns(db, 'idx_jobs_draft_created'), ['draft_id', 'created_at']);
    assert.deepEqual(indexColumns(db, 'idx_jobs_status_created'), ['status', 'created_at']);
  } finally {
    db.close();
  }
});

test('a legacy DB (user_version 0, old shapes) is upgraded with its rows preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-studio-'));
  try {
    const file = join(dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE server_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      comfy_host TEXT NOT NULL DEFAULT '',
      ollama_host TEXT NOT NULL DEFAULT '',
      kokoro_host TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE drafts (
      id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, language TEXT NOT NULL,
      voice_a TEXT NOT NULL, voice_b TEXT NOT NULL, mix INTEGER NOT NULL DEFAULT 0, escaleta TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '',
      progress REAL NOT NULL DEFAULT 0, error TEXT, output_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );
    INSERT INTO server_settings (id, comfy_host, kokoro_host) VALUES (1, 'http://c:1', 'http://k:8880');
    INSERT INTO drafts VALUES ('d1','text','x','es','a','b',0,'{}','draft','t','t');
    INSERT INTO jobs (id, draft_id, status, created_at, updated_at) VALUES ('j1','d1','done','t','t');`);
    assert.equal(userVersion(old), 0);
    old.close();

    const db = openDatabase(file);
    try {
      const settings = columnNames(db, 'server_settings');
      assert.ok(settings.includes('piper_host') && settings.includes('ollama_model'));
      assert.ok(!settings.includes('kokoro_host'));
      assert.ok(columnNames(db, 'jobs').includes('options'));
      const row = db.prepare('SELECT comfy_host, piper_host FROM server_settings WHERE id = 1').get() as {
        comfy_host: string;
        piper_host: string;
      };
      assert.deepEqual({ ...row }, { comfy_host: 'http://c:1', piper_host: '' });
      assert.equal((db.prepare("SELECT count(*) AS n FROM jobs WHERE id = 'j1'").get() as { n: number }).n, 1);
      assert.ok(indexNames(db).includes('idx_jobs_draft_created'));
      assert.ok(indexNames(db).includes('idx_jobs_status_created'));
      assert.equal(userVersion(db), LATEST);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an up-to-date DB is not migrated again on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-studio-'));
  try {
    const file = join(dir, 'gate.sqlite');
    const first = openDatabase(file);
    first.exec('DROP INDEX idx_jobs_status_created');
    first.close();
    const second = openDatabase(file);
    try {
      assert.ok(!indexNames(second).includes('idx_jobs_status_created'));
      assert.equal(userVersion(second), LATEST);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runMigrations applies only versions above the current one, in order', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ran: number[] = [];
    const mk = (version: number): Migration => ({ version, name: `m${version}`, up: () => void ran.push(version) });
    db.exec('PRAGMA user_version = 1');
    runMigrations(db, [mk(1), mk(2), mk(3)]);
    assert.deepEqual(ran, [2, 3]);
    assert.equal(userVersion(db), 3);
    runMigrations(db, [mk(1), mk(2), mk(3)]);
    assert.deepEqual(ran, [2, 3]);
  } finally {
    db.close();
  }
});

test('a failing migration rolls back, keeps user_version and stops later migrations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ran: number[] = [];
    const list: Migration[] = [
      { version: 1, name: 'ok', up: (d) => { d.exec('CREATE TABLE a (x)'); ran.push(1); } },
      { version: 2, name: 'boom', up: (d) => { d.exec('CREATE TABLE b (x)'); throw new Error('boom'); } },
      { version: 3, name: 'never', up: () => void ran.push(3) },
    ];
    assert.throws(() => runMigrations(db, list), /boom/);
    assert.equal(userVersion(db), 1);
    assert.deepEqual(ran, [1]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    assert.ok(tables.includes('a') && !tables.includes('b'));
  } finally {
    db.close();
  }
});

test('runMigrations rejects duplicate or out-of-order versions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const mk = (version: number): Migration => ({ version, name: `m${version}`, up: () => {} });
    assert.throws(() => runMigrations(db, [mk(1), mk(1)]), /strictly increasing/);
    assert.throws(() => runMigrations(db, [mk(2), mk(1)]), /strictly increasing/);
    assert.equal(userVersion(db), 0);
  } finally {
    db.close();
  }
});

test('the schema no longer lives in a schema.sql file read from disk', () => {
  assert.equal(existsSync(join(__dirname, '../src/db/schema.sql')), false);
  const db = openDatabase(':memory:');
  assert.ok(columnNames(db, 'jobs').includes('options'));
  db.close();
});
