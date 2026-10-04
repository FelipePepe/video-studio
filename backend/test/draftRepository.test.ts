import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection';
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

test('unknown ids throw DraftNotFoundError', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => updateEscaleta(db, 'x', escaleta), DraftNotFoundError);
  assert.throws(() => markApproved(db, 'x'), DraftNotFoundError);
});
