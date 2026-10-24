import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';

// These helpers run inside the transaction opened by runMigrations.
// Databases created before the Kokoro -> Piper switch still carry `kokoro_host`.
// CREATE TABLE IF NOT EXISTS does not touch them, so rename the column here and
// drop its value: an old Kokoro http URL is not a valid Piper tcp:// host.
function migrateKokoroHostToPiperHost(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map((c) => c.name);
  if (columns.includes('kokoro_host') && !columns.includes('piper_host')) {
    db.exec('ALTER TABLE server_settings RENAME COLUMN kokoro_host TO piper_host');
    db.exec("UPDATE server_settings SET piper_host = ''");
  }
}

// Databases that predate E1 (BGM options) have no `jobs.options` column.
// CREATE TABLE IF NOT EXISTS does not add columns to existing tables.
function migrateJobsOptionsColumn(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('options')) {
    db.exec('ALTER TABLE jobs ADD COLUMN options TEXT');
  }
}

function migrateServerSettingsOllamaModel(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(server_settings)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('ollama_model')) {
    db.exec("ALTER TABLE server_settings ADD COLUMN ollama_model TEXT NOT NULL DEFAULT ''");
  }
}

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

// Append-only and ordered. Each entry runs once, in its own transaction, and is
// recorded in PRAGMA user_version.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'legacy-catch-up',
    up(db) {
      migrateKokoroHostToPiperHost(db);
      migrateServerSettingsOllamaModel(db);
      migrateJobsOptionsColumn(db);
    },
  },
  {
    version: 2,
    name: 'jobs-indexes',
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_draft_created ON jobs(draft_id, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)');
    },
  },
];

export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  for (let i = 0; i < migrations.length; i++) {
    const v = migrations[i].version;
    if (!Number.isInteger(v) || v < 1 || (i > 0 && v <= migrations[i - 1].version)) {
      throw new Error(`Migration versions must be strictly increasing integers (got ${v} at index ${i})`);
    }
  }
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
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
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}
