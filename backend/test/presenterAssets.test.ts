import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresenterAssets } from '../src/characters/presenterAssets';
import type { Character } from '../src/characters/characterRepository';

const base: Character = {
  id: 'ana',
  name: 'Ana',
  description: 'd',
  seed: 1,
  imagePath: '/abs/ana/character.png',
  keyColor: '0x1e941b',
  crop: { x: 1, y: 2, w: 3, h: 4 },
  width: 1024,
  height: 1024,
  mouthY: null,
  mouth: null,
  status: 'approved',
  createdAt: 't',
  updatedAt: 't',
};

const repoOf = (c: Character | undefined) => ({ get: () => c });

test('approved character resolves without mouthY when NULL', async () => {
  const r = await createPresenterAssets(repoOf(base), () => true)('ana');
  assert.deepEqual(r, { imagePath: base.imagePath, keyColor: base.keyColor, crop: base.crop });
  assert.equal('mouthY' in r, false);
});

test('mouthY is included when set', async () => {
  const r = await createPresenterAssets(repoOf({ ...base, mouthY: 0.6 }), () => true)('ana');
  assert.equal(r.mouthY, 0.6);
});

test('rejections: not approved, unknown, invalid id, missing file', async () => {
  await assert.rejects(createPresenterAssets(repoOf({ ...base, status: 'generated' }), () => true)('ana'), /is not approved/);
  await assert.rejects(createPresenterAssets(repoOf(undefined), () => true)('ana'), /not found/);
  let called = false;
  const spy = { get: () => { called = true; return base; } };
  await assert.rejects(createPresenterAssets(spy, () => true)('../x'));
  assert.equal(called, false);
  await assert.rejects(createPresenterAssets(repoOf(base), () => false)('ana'), /image is missing/);
});

test('mouth is included when present and omitted when null', async () => {
  const mouth = { x: 5, y: 6, w: 7, h: 8 };
  const r = await createPresenterAssets(repoOf({ ...base, mouth }), () => true)('ana');
  assert.deepEqual(r.mouth, mouth);
  const n = await createPresenterAssets(repoOf(base), () => true)('ana');
  assert.equal('mouth' in n, false);
});
