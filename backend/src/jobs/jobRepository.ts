import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ApproveOptions } from '../pipeline/types';
import { Job, JobStatus } from './types';

export type Clock = () => Date;
export type IdFactory = () => string;

interface JobRow {
  id: string;
  draft_id: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  output_path: string | null;
  options: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  warnings: string | null;
}

export interface JobPatch {
  stage?: string;
  progress?: number;
  error?: string | null;
  outputPath?: string | null;
}

const now: Clock = () => new Date();

const MAX_WARNINGS = 50;
const MAX_WARNING_LENGTH = 500;

function parseWarnings(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

function fromRow(r: JobRow): Job {
  return {
    id: r.id,
    draftId: r.draft_id,
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    error: r.error,
    outputPath: r.output_path,
    options: r.options ? (JSON.parse(r.options) as ApproveOptions) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    warnings: parseWarnings(r.warnings),
  };
}

export function getJob(db: DatabaseSync, id: string): Job | undefined {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function createJob(db: DatabaseSync, draftId: string, clock: Clock = now, newId: IdFactory = randomUUID, opts: ApproveOptions | null = null): Job {
  const id = newId();
  const ts = clock().toISOString();
  db.prepare(
    `INSERT INTO jobs (id, draft_id, status, stage, progress, options, created_at, updated_at)
     VALUES (?, ?, 'queued', '', 0, ?, ?, ?)`,
  ).run(id, draftId, opts ? JSON.stringify(opts) : null, ts, ts);
  return getJob(db, id) as Job;
}

export function getLatestJobForDraft(db: DatabaseSync, draftId: string): Job | undefined {
  const row = db
    .prepare('SELECT * FROM jobs WHERE draft_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(draftId) as unknown as JobRow | undefined;
  return row ? fromRow(row) : undefined;
}

// Minimal job shape needed by the work-dir retention planner (id, status, finishedAt).
export interface RetentionJobInfo {
  id: string;
  status: string;
  finishedAt: string | null;
}
export function retentionJobs(db: DatabaseSync): RetentionJobInfo[] {
  const rows = db.prepare('SELECT id, status, finished_at FROM jobs').all() as unknown as Array<{
    id: string;
    status: string;
    finished_at: string | null;
  }>;
  return rows.map((r) => ({ id: r.id, status: r.status, finishedAt: r.finished_at }));
}

export function listJobs(db: DatabaseSync, opts: { limit?: number; status?: JobStatus } = {}): Job[] {
  const { limit = 50, status } = opts;
  const rows = status
    ? db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
  return (rows as unknown as JobRow[]).map(fromRow);
}

const COLUMNS: Record<string, string> = {
  stage: 'stage',
  progress: 'progress',
  error: 'error',
  outputPath: 'output_path',
  status: 'status',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

function patchJob(db: DatabaseSync, id: string, fields: Record<string, SQLInputValue | undefined>, clock: Clock): Job | undefined {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const sets = [...entries.map(([k]) => `${COLUMNS[k]} = ?`), 'updated_at = ?'];
  const values = [...entries.map(([, v]) => v as SQLInputValue), clock().toISOString(), id];
  const res = db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return res.changes === 0 ? undefined : getJob(db, id);
}

export function updateJob(db: DatabaseSync, id: string, patch: JobPatch, clock: Clock = now): Job | undefined {
  return patchJob(db, id, { ...patch }, clock);
}

/** Appends a warning (newest last), keeping the latest 50 and truncating each text to 500 chars. */
export function addJobWarning(db: DatabaseSync, id: string, text: string, clock: Clock = now): Job | undefined {
  const row = db.prepare('SELECT warnings FROM jobs WHERE id = ?').get(id) as unknown as { warnings: string | null } | undefined;
  if (!row) return undefined;
  const next = [...parseWarnings(row.warnings), text.slice(0, MAX_WARNING_LENGTH)].slice(-MAX_WARNINGS);
  db.prepare('UPDATE jobs SET warnings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), clock().toISOString(), id);
  return getJob(db, id);
}

export function markRunning(db: DatabaseSync, id: string, clock: Clock = now): Job | undefined {
  return patchJob(db, id, { status: 'running', startedAt: clock().toISOString() }, clock);
}

export function markDone(db: DatabaseSync, id: string, outputPath: string, clock: Clock = now): Job | undefined {
  return patchJob(db, id, { status: 'done', outputPath, progress: 1, finishedAt: clock().toISOString() }, clock);
}

export function markFailed(db: DatabaseSync, id: string, error: string, clock: Clock = now): Job | undefined {
  return patchJob(db, id, { status: 'failed', error, finishedAt: clock().toISOString() }, clock);
}

export function markCancelled(db: DatabaseSync, id: string, clock: Clock = now): Job | undefined {
  return patchJob(db, id, { status: 'cancelled', finishedAt: clock().toISOString() }, clock);
}

/**
 * Delete a job's row. Returns the number of rows removed (1 when the job existed,
 * 0 otherwise). Does NOT touch the linked draft — a draft stays re-approvable.
 */
export function deleteJob(db: DatabaseSync, id: string): number {
  const res = db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return Number(res.changes);
}

export function failInterruptedJobs(db: DatabaseSync, clock: Clock = now): number {
  const ts = clock().toISOString();
  const res = db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'interrupted by server restart', finished_at = ?, updated_at = ?
       WHERE status IN ('queued','running')`,
    )
    .run(ts, ts);
  return Number(res.changes);
}
