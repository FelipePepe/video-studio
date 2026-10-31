import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection';
import { createJob, markCancelled, markDone, markFailed, markRunning } from '../src/jobs/jobRepository';
import {
  createDraft,
  getDraft,
  updateEscaleta,
  markApproved,
  DraftLockedError,
  DraftNotFoundError,
} from '../src/pipeline/draftRepository';
import type { Escaleta } from '../src/pipeline/types';

const escaleta: Escaleta = [{ scene: 1, title: 't', narration: 'n', visualPrompt: 'v', voice: 'male' }];
const input = {
  sourceKind: 'text' as const,
  sourceRef: 'hola',
  language: 'es',
  voiceA: 'male',
  voiceB: 'female',
  mix: true,
  escaleta,
};

function clock(...iso: string[]) {
  let i = 0;
  return () => new Date(iso[Math.min(i++, iso.length - 1)]);
}

test('createDraft persists and getDraft round-trips', () => {
  const db = openDatabase(':memory:');
  const d = createDraft(db, input, clock('2026-01-01T00:00:00.000Z'));
  assert.match(d.id, /^[0-9a-f-]{36}$/);
  assert.equal(d.status, 'draft');
  assert.equal(d.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(getDraft(db, d.id), d);
  assert.equal(getDraft(db, d.id)?.mix, true);
});

test('escaleta scenes round-trip their optional speaker field (A/B/absent)', () => {
  const db = openDatabase(':memory:');
  const withSpeakers: Escaleta = [
    { scene: 1, title: 'a', narration: 'n1', visualPrompt: 'v', voice: 'male', speaker: 'A' },
    { scene: 2, title: 'b', narration: 'n2', visualPrompt: 'v', voice: 'female', speaker: 'B' },
    { scene: 3, title: 'legacy', narration: 'n3', visualPrompt: 'v', voice: 'male' },
  ];
  const d = createDraft(db, { ...input, escaleta: withSpeakers }, clock('2026-01-01T00:00:00.000Z'));
  const round = getDraft(db, d.id)!;
  assert.equal(round.escaleta[0].speaker, 'A');
  assert.equal(round.escaleta[1].speaker, 'B');
  assert.equal(round.escaleta[2].speaker, undefined);
  assert.ok(!('speaker' in round.escaleta[2]), 'speakerless scene must not carry a speaker key');
});

test('getDraft returns undefined for unknown ids', () => {
  assert.equal(getDraft(openDatabase(':memory:'), 'nope'), undefined);
});

test('updateEscaleta replaces the escaleta and bumps updatedAt while in draft', () => {
  const db = openDatabase(':memory:');
  const d = createDraft(db, input, clock('2026-01-01T00:00:00.000Z'));
  const next = [{ ...escaleta[0], title: 'changed' }];
  const u = updateEscaleta(db, d.id, next, clock('2026-01-02T00:00:00.000Z'));
  assert.equal(u.escaleta[0].title, 'changed');
  assert.equal(u.updatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(u.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(getDraft(db, d.id)?.escaleta[0].title, 'changed');
});

test('markApproved locks the draft', () => {
  const db = openDatabase(':memory:');
  const d = createDraft(db, input);
  assert.equal(markApproved(db, d.id).status, 'approved');
  assert.throws(() => updateEscaleta(db, d.id, escaleta), DraftLockedError);
  assert.throws(() => markApproved(db, d.id), DraftLockedError);
  assert.equal(getDraft(db, d.id)?.status, 'approved');
});

test('updateEscaleta unlocks when the latest job is failed or cancelled (X1)', () => {
  const failedScenario = (mark: (db: Parameters<typeof markFailed>[0], id: string) => unknown) => {
    const db = openDatabase(':memory:');
    const d = createDraft(db, input);
    markApproved(db, d.id);
    const job = createJob(db, d.id);
    mark(db, job.id);
    const next = [{ ...escaleta[0], title: 'retried' }];
    const u = updateEscaleta(db, d.id, next);
    assert.equal(u.escaleta[0].title, 'retried');
    assert.equal(u.status, 'approved');
  };
  const markFailedNow = (db: Parameters<typeof markFailed>[0], id: string) => markFailed(db, id, 'boom');
  failedScenario(markFailedNow);
  failedScenario(markCancelled);
});

test('updateEscaleta stays locked while the latest job is running or done (X1)', () => {
  const mk = (mark: (db: Parameters<typeof markFailed>[0], id: string) => unknown) => {
    const db = openDatabase(':memory:');
    const d = createDraft(db, input);
    markApproved(db, d.id);
    mark(db, createJob(db, d.id).id);
    assert.throws(() => updateEscaleta(db, d.id, escaleta), DraftLockedError);
  };
  const markRunningNow = (db: Parameters<typeof markFailed>[0], id: string) => markRunning(db, id);
  mk(markRunningNow);
  mk((db, id) => markDone(db, id, 'out.mp4')); // a successful ('done') job keeps the draft locked
});

test('unknown ids throw DraftNotFoundError', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => updateEscaleta(db, 'x', escaleta), DraftNotFoundError);
  assert.throws(() => markApproved(db, 'x'), DraftNotFoundError);
});
