import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { listMusicDir, MusicLibraryError, type MusicFile } from '../src/lib/musicLibrary';
import { musicRouter } from '../src/routes/music';
import { buildApp } from '../src/app';

const tmpDirs: string[] = [];
after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function makeDir(files: Record<string, string | null>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    if (content === null) fs.mkdirSync(path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('listMusicDir returns only audio files, sorted by name', () => {
  const dir = makeDir({
    'zeta.mp3': 'audio',
    'alpha.ogg': 'audio',
    'beta.flac': 'audio',
    'notes.txt': 'nope',
    'gamma.MP3': 'audio',
    'delta.m4a': 'audio',
    'eps.wav': 'audio',
    'subdir': null,
  });
  const files = listMusicDir(dir);
  assert.deepEqual(
    files.map((f) => f.name),
    ['alpha.ogg', 'beta.flac', 'delta.m4a', 'eps.wav', 'gamma.MP3', 'zeta.mp3'],
  );
  for (const f of files) {
    assert.equal(f.path, path.join(dir, f.name));
  }
});

test('listMusicDir returns an empty list for an empty directory', () => {
  const dir = makeDir({ 'readme.md': 'x' });
  assert.deepEqual(listMusicDir(dir), []);
});

test('listMusicDir throws MusicLibraryError for a missing directory', () => {
  assert.throws(() => listMusicDir(path.join(os.tmpdir(), 'no-such-music-dir-xyz')), MusicLibraryError);
});

test('listMusicDir throws MusicLibraryError when the path is a file', () => {
  const dir = makeDir({ 'a.mp3': 'x' });
  assert.throws(() => listMusicDir(path.join(dir, 'a.mp3')), MusicLibraryError);
});

test('listMusicDir resolves a symlinked dir so persisted paths are stable (F5)', () => {
  const real = makeDir({ 'a.mp3': 'x' });
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const files = listMusicDir(link);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, path.join(real, 'a.mp3'));
});

test('GET /api/music lists the MUSIC_DIR contents with absolute paths', async () => {
  const dir = makeDir({ 'a.mp3': 'audio', 'b.ogg': 'audio' });
  const app = buildApp({ musicDir: dir });
  const res = await request(app).get('/api/music').expect(200);
  assert.equal(res.body.musicDir, dir);
  assert.ok(Array.isArray(res.body.files));
  assert.deepEqual(res.body.files.map((f: MusicFile) => f.name), ['a.mp3', 'b.ogg']);
});

test('GET /api/music returns 404 when the library is not configured', async () => {
  const app = buildApp({ musicDir: '' });
  const res = await request(app).get('/api/music').expect(404);
  assert.match(res.body.error, /not configured/i);
});

test('GET /api/music returns 404 when the directory cannot be listed', async () => {
  const app = buildApp({ musicDir: path.join(os.tmpdir(), 'no-such-music-dir-xyz') });
  const res = await request(app).get('/api/music').expect(404);
  assert.match(res.body.error, /not a directory|not found|not accessible/i);
});
