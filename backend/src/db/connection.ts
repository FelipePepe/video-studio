import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Databases created before the Kokoro -> Piper switch still carry `kokoro_host`.
// CREATE TABLE IF NOT EXISTS does not touch them, so rename the column here and
// drop its value: an old Kokoro http URL is not a valid Piper tcp:// host.
function migrateKokoroHostToPiperHost(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map((c) => c.name);
  if (columns.includes('kokoro_host') && !columns.includes('piper_host')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE server_settings RENAME COLUMN kokoro_host TO piper_host');
      db.exec("UPDATE server_settings SET piper_host = ''");
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// Databases that predate E1 (BGM options) have no `jobs.options` column.
// CREATE TABLE IF NOT EXISTS does not add columns to existing tables.
function migrateJobsOptionsColumn(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('options')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE jobs ADD COLUMN options TEXT');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function migrateServerSettingsOllamaModel(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('ollama_model')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec("ALTER TABLE server_settings ADD COLUMN ollama_model TEXT NOT NULL DEFAULT ''");
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function openDatabase(path: string = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  migrateKokoroHostToPiperHost(db);
  migrateServerSettingsOllamaModel(db);
  migrateJobsOptionsColumn(db);
  return db;
}
