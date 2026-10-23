import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection';
import {
  getSettings,
  loadEnvDefaults,
  resolveEffectiveConfig,
  updateSettings,
  validateHostUrl,
  validatePiperHost,
} from '../src/config/settings';

test('loadEnvDefaults uses built-in defaults when env is empty', () => {
  assert.deepEqual(loadEnvDefaults({}), {
    comfyHost: 'http://192.168.1.60:8188',
    ollamaHost: 'http://192.168.1.60:11434',
    piperHost: 'tcp://192.168.1.60:10200',
    ollamaModel: 'gemma4:26b',
  });
});

test('loadEnvDefaults reads COMFY_HOST, OLLAMA_HOST and PIPER_HOST', () => {
  const env = loadEnvDefaults({
    COMFY_HOST: 'http://c:1',
    OLLAMA_HOST: 'http://o:2',
    PIPER_HOST: 'tcp://k:3',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(env, {
    comfyHost: 'http://c:1',
    ollamaHost: 'http://o:2',
    piperHost: 'tcp://k:3',
    ollamaModel: 'gemma4:26b',
  });
});

test('loadEnvDefaults reads OLLAMA_MODEL when set', () => {
  const env = loadEnvDefaults({ OLLAMA_MODEL: 'qwen3:14b' } as NodeJS.ProcessEnv);
  assert.equal(env.ollamaModel, 'qwen3:14b');
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
  assert.deepEqual(getSettings(db), { comfyHost: '', ollamaHost: '', piperHost: '', ollamaModel: '' });
});

test('updateSettings upserts and applies partial patches', () => {
  const db = openDatabase(':memory:');
  updateSettings(db, { comfyHost: 'http://c:1' });
  assert.deepEqual(getSettings(db), { comfyHost: 'http://c:1', ollamaHost: '', piperHost: '', ollamaModel: '' });
  updateSettings(db, { ollamaHost: 'http://o:2' });
  assert.deepEqual(getSettings(db), { comfyHost: 'http://c:1', ollamaHost: 'http://o:2', piperHost: '', ollamaModel: '' });
  updateSettings(db, { comfyHost: '' });
  assert.equal(getSettings(db).comfyHost, '');
});

test('resolveEffectiveConfig prefers non-empty DB values over env defaults', () => {
  const db = openDatabase(':memory:');
  const envDefaults = loadEnvDefaults({});
  assert.deepEqual(resolveEffectiveConfig(db, envDefaults), envDefaults);
  updateSettings(db, { piperHost: 'tcp://k:9' });
  assert.deepEqual(resolveEffectiveConfig(db, envDefaults), { ...envDefaults, piperHost: 'tcp://k:9' });
});

test('validatePiperHost accepts tcp://host:port and empty', () => {
  assert.equal(validatePiperHost('tcp://192.168.1.60:10200'), true);
  assert.equal(validatePiperHost('tcp://piper.local:1'), true);
  assert.equal(validatePiperHost('tcp://h:65535'), true);
  assert.equal(validatePiperHost(''), true);
});

test('validatePiperHost rejects http, missing or out-of-range port, paths and non-strings', () => {
  for (const bad of ['http://h:10200', 'https://h:1', 'tcp://h', 'tcp://h:0', 'tcp://h:65536', 'tcp://:80', 'tcp://h:80/x', 'h:80', 42, null]) {
    assert.equal(validatePiperHost(bad), false, String(bad));
  }
});
