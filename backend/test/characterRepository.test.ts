import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDatabase, runMigrations } from '../src/db/connection';
import {
  createCharacterRepository,
  isValidCharacterId,
  type CharacterRepository,
} from '../src/characters/characterRepository';
import type { CharacterAnalysis } from '../src/media/characterAnalysis';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'chars-'));
  dirs.push(d);
  return d;
};

const analysis: CharacterAnalysis = {
  keyColor: '0x1e941b',
  width: 1024,
  height: 1024,
  crop: { x: 10, y: 20, w: 300, h: 400 },
};
const png = Buffer.from('fake-png-bytes');

function setup(newId?: () => string, tick = 0): { repo: CharacterRepository; dir: string; db: DatabaseSync } {
  const dir = resolve(tmp(), 'characters');
  const db = openDatabase(':memory:');
  let n = 0;
  const repo = createCharacterRepository(db, dir, {
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick + n++)),
    newId,
  });
  return { repo, dir, db };
}

const input = (name = 'Ana') => ({ name, description: 'a red fox', seed: 7, png, analysis });

test('a fresh database has the characters table; migration 4 creates it on a v3 database', () => {
  const fresh = openDatabase(':memory:');
  assert.ok(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'characters'").get());
  fresh.close();

  const old = new DatabaseSync(':memory:');
  old.exec('PRAGMA user_version = 3');
  assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name = 'characters'").get(), undefined);
  runMigrations(old);
  assert.ok(old.prepare("SELECT name FROM sqlite_master WHERE name = 'characters'").get());
  assert.ok(MIGRATIONS.some((m) => m.version === 4 && m.name === 'characters-table'));
  old.close();
});

test('create writes the PNG inside charactersDir and stores the analysis', () => {
  const { repo, dir } = setup(() => 'id-1');
  const c = repo.create(input());
  assert.equal(c.id, 'id-1');
  assert.equal(c.imagePath, join(dir, 'id-1', 'character.png'));
  assert.ok(c.imagePath.startsWith(dir + sep));
  assert.ok(existsSync(c.imagePath));
  assert.equal(c.keyColor, '0x1e941b');
  assert.deepEqual(c.crop, analysis.crop);
  assert.equal(c.status, 'generated');
  assert.equal(c.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(c.updatedAt, c.createdAt);
  assert.equal(c.mouthY, null);
});

test('get and list round-trip and list is newest first', () => {
  let i = 0;
  const { repo } = setup(() => `id-${++i}`);
  repo.create(input('first'));
  repo.create(input('second'));
  const got = repo.get('id-1');
  assert.deepEqual(got?.crop, analysis.crop);
  assert.equal(got?.mouthY, null);
  assert.deepEqual(repo.list().map((c) => c.id), ['id-2', 'id-1']);
  assert.equal(repo.get('nope'), undefined);
});

test('approve sets status, stores mouthY, is idempotent and unknown ids give undefined', () => {
  const { repo } = setup(() => 'id-1');
  repo.create(input());
  const a = repo.approve('id-1', { mouthY: 0.6 });
  assert.equal(a?.status, 'approved');
  assert.equal(a?.mouthY, 0.6);
  const b = repo.approve('id-1');
  assert.equal(b?.status, 'approved');
  assert.equal(b?.mouthY, 0.6);
  assert.equal(repo.approve('ghost'), undefined);
});

test('remove deletes row and directory; unknown id gives false', () => {
  const { repo, dir } = setup(() => 'id-1');
  repo.create(input());
  assert.equal(repo.remove('id-1'), true);
  assert.equal(repo.get('id-1'), undefined);
  assert.equal(existsSync(join(dir, 'id-1')), false);
  assert.equal(repo.remove('id-1'), false);
});

test('path safety: invalid ids never touch the filesystem', () => {
  const { repo, dir } = setup();
  const sentinel = join(dir, '..', 'sentinel');
  writeFileSync(sentinel, 'x');
  for (const bad of ['../sentinel', '../x', 'a/b', '', 'a'.repeat(65)]) {
    assert.equal(repo.get(bad), undefined);
    assert.equal(repo.approve(bad), undefined);
    assert.equal(repo.remove(bad), false);
  }
  assert.ok(existsSync(sentinel));
  for (const ok of ['ana', 'a_B-9', 'a'.repeat(64)]) assert.equal(isValidCharacterId(ok), true);
  for (const bad of ['a'.repeat(65), '.', '..', 'a b', 'a/b', '']) assert.equal(isValidCharacterId(bad), false);
});

test('a failing insert cleans the second directory and keeps the first character', () => {
  const { repo, dir } = setup(() => 'dup');
  const first = repo.create(input());
  assert.throws(() => repo.create(input('again')));
  assert.equal(repo.list().length, 1);
  assert.equal(repo.get('dup')?.name, first.name);
  assert.ok(existsSync(join(dir, 'dup', 'character.png')));
});
