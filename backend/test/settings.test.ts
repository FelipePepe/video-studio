import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection';
import {
  getSettings,
  loadEnvDefaults,
  resolveEffectiveConfig,
  updateSettings,
  validateHostUrl,
} from '../src/config/settings';

test('loadEnvDefaults uses built-in defaults when env is empty', () => {
  assert.deepEqual(loadEnvDefaults({}), {
    comfyHost: 'http://192.168.1.60:8188',
    ollamaHost: 'http://192.168.1.60:11434',
    kokoroHost: 'http://localhost:8880',
  });
});

test('loadEnvDefaults reads COMFY_HOST, OLLAMA_HOST and KOKORO_HOST', () => {
  const env = loadEnvDefaults({
    COMFY_HOST: 'http://c:1',
    OLLAMA_HOST: 'http://o:2',
    KOKORO_HOST: 'http://k:3',
  });
  assert.deepEqual(env, { comfyHost: 'http://c:1', ollamaHost: 'http://o:2', kokoroHost: 'http://k:3' });
});

test('validateHostUrl accepts http, https and empty', () => {
  assert.equal(validateHostUrl('http://a:1'), true);
  assert.equal(validateHostUrl('https://a.b/c'), true);
  assert.equal(validateHostUrl(''), true);
});

test('validateHostUrl rejects other schemes, garbage and non-strings', () => {
  assert.equal(validateHostUrl('ftp://x'), false);
  assert.equal(validateHostUrl('not a url'), false);
  assert.equal(validateHostUrl(42), false);
  assert.equal(validateHostUrl(null), false);
});

test('getSettings returns empty strings on a fresh database', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(getSettings(db), { comfyHost: '', ollamaHost: '', kokoroHost: '' });
});

test('updateSettings upserts and applies partial patches', () => {
  const db = openDatabase(':memory:');
  updateSettings(db, { comfyHost: 'http://c:1' });
  assert.deepEqual(getSettings(db), { comfyHost: 'http://c:1', ollamaHost: '', kokoroHost: '' });
  updateSettings(db, { ollamaHost: 'http://o:2' });
  assert.deepEqual(getSettings(db), { comfyHost: 'http://c:1', ollamaHost: 'http://o:2', kokoroHost: '' });
  updateSettings(db, { comfyHost: '' });
  assert.equal(getSettings(db).comfyHost, '');
});

test('resolveEffectiveConfig prefers non-empty DB values over env defaults', () => {
  const db = openDatabase(':memory:');
  const envDefaults = loadEnvDefaults({});
  assert.deepEqual(resolveEffectiveConfig(db, envDefaults), envDefaults);
  updateSettings(db, { kokoroHost: 'http://k:9' });
  assert.deepEqual(resolveEffectiveConfig(db, envDefaults), { ...envDefaults, kokoroHost: 'http://k:9' });
});
