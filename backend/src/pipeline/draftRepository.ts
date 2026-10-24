import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Draft, Escaleta } from './types';
import { getLatestJobForDraft } from '../jobs/jobRepository';

export class DraftLockedError extends Error {}
export class DraftNotFoundError extends Error {}

export type NewDraft = Omit<Draft, 'id' | 'status' | 'createdAt' | 'updatedAt'>;
export type Clock = () => Date;

interface DraftRow {
  id: string;
  source_kind: 'url' | 'text';
  source_ref: string;
  language: string;
  voice_a: string;
  voice_b: string;
  mix: number;
  escaleta: string;
  status: 'draft' | 'approved';
  created_at: string;
  updated_at: string;
}

const now: Clock = () => new Date();

function fromRow(r: DraftRow): Draft {
  return {
    id: r.id,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    language: r.language,
    voiceA: r.voice_a,
    voiceB: r.voice_b,
    mix: r.mix === 1,
    escaleta: JSON.parse(r.escaleta) as Escaleta,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getDraft(db: DatabaseSync, id: string): Draft | undefined {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as unknown as DraftRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function createDraft(db: DatabaseSync, draft: NewDraft, clock: Clock = now): Draft {
  const id = randomUUID();
  const ts = clock().toISOString();
  db.prepare(
    `INSERT INTO drafts (id, source_kind, source_ref, language, voice_a, voice_b, mix, escaleta, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(
    id,
    draft.sourceKind,
    draft.sourceRef,
    draft.language,
    draft.voiceA,
    draft.voiceB,
    draft.mix ? 1 : 0,
    JSON.stringify(draft.escaleta),
    ts,
    ts,
  );
  return getDraft(db, id) as Draft;
}

function failUnchanged(db: DatabaseSync, id: string): never {
  if (!getDraft(db, id)) throw new DraftNotFoundError(`Draft ${id} not found`);
  throw new DraftLockedError(`Draft ${id} is already approved`);
}

export function updateEscaleta(db: DatabaseSync, id: string, escaleta: Escaleta, clock: Clock = now): Draft {
  const res = db
    .prepare("UPDATE drafts SET escaleta = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
    .run(JSON.stringify(escaleta), clock().toISOString(), id);
  if (res.changes > 0) return getDraft(db, id) as Draft;
  if (!getDraft(db, id)) throw new DraftNotFoundError(`Draft ${id} not found`);
  // Already approved: unlocking for the retry loop — the user may fix the
  // escaleta (segments) and approve again when the last attempt did not produce
  // video. While a job is queued/running/done the draft stays locked.
  const latest = getLatestJobForDraft(db, id);
  if (latest && (latest.status === 'failed' || latest.status === 'cancelled')) {
    const unlocked = db.prepare('UPDATE drafts SET escaleta = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(escaleta), clock().toISOString(), id);
    if (unlocked.changes > 0) return getDraft(db, id) as Draft;
  }
  throw new DraftLockedError(`Draft ${id} is already approved`);
}

export function markApproved(db: DatabaseSync, id: string, clock: Clock = now): Draft {
  const res = db
    .prepare("UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'draft'")
    .run(clock().toISOString(), id);
  if (res.changes === 0) failUnchanged(db, id);
  return getDraft(db, id) as Draft;
}
