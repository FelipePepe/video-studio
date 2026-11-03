import { test } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { buildApp } from '../src/app';
import { openDatabase } from '../src/db/connection';
import { loadEnvDefaults } from '../src/config/settings';
import type { ComfyClient } from '../src/clients/comfy';
import type { OllamaClient } from '../src/clients/ollama';
import type { PiperClient } from '../src/clients/piper';
import {
  generatePublishMetadata,
  PublishInputError,
  validatePublishMetadata,
} from '../src/pipeline/publish';
import type { Escaleta } from '../src/pipeline/types';

const escaleta: Escaleta = [
  { scene: 1, title: 'a', narration: 'n1', visualPrompt: 'v', voice: 'male' },
  { scene: 2, title: 'b', narration: 'n2', visualPrompt: 'v', voice: 'female' },
];

const GOOD = {
  title: 'Un video corto',
  description: 'Resumen del articulo en dos lineas.',
  tags: ['ciencia', 'cena'],
  hashtags: ['#shorts', 'ciencia'],
  hook: 'Esto te va a sorprender',
  cta: 'Suscribete para mas videos como este',
};

test('validatePublishMetadata accepts a well-formed object and normalizes hashtags', () => {
  const m = validatePublishMetadata(GOOD);
  assert.deepEqual(m.hashtags, ['shorts', 'ciencia']);
  assert.equal(m.title, GOOD.title);
  assert.deepEqual(m.tags, GOOD.tags);
});

test('validatePublishMetadata rejects missing fields / over-limit / empty tags', () => {
  assert.throws(() => validatePublishMetadata({}), /title/);
  assert.throws(
    () => validatePublishMetadata({ ...GOOD, tags: [] }),
    /tags/,
    'empty tags list is rejected',
  );
  assert.throws(
    () => validatePublishMetadata({ ...GOOD, title: 'x'.repeat(200) }),
    /title/,
    'oversized title is rejected',
  );
  assert.throws(
    () => validatePublishMetadata({ ...GOOD, hook: Array(20).fill('aaaa').join(' ') }),
    /hook/,
    'a too-long hook is rejected',
  );
});

test('generatePublishMetadata returns the model output via Ollama', async () => {
  const ollama = { chatJson: async () => GOOD } as unknown as OllamaClient;
  const got = await generatePublishMetadata({ language: 'es', escaleta }, { ollama });
  assert.equal(got.title, 'Un video corto');
  assert.equal(got.hashtags.length, 2);
});

test('generatePublishMetadata throws PublishInputError on an invalid model answer', async () => {
  const ollama = { chatJson: async () => ({ no: 'shape' }) } as unknown as OllamaClient;
  try {
    await generatePublishMetadata({ language: 'es', escaleta }, { ollama });
    assert.fail('expected PublishInputError');
  } catch (e) {
    assert.ok(e instanceof PublishInputError, 'PublishInputError');
  }
});

function setupApp(ollama: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'vs-pub-r-'));
  (test as unknown as { dirs?: string[] }).dirs ??= [];
  (test as unknown as { dirs: string[] }).dirs.push(dir);
  return buildApp({
    db: openDatabase(':memory:'),
    envDefaults: loadEnvDefaults({}),
    ollama: ollama as OllamaClient,
    comfy: {
      submit: async () => 'p1',
      waitForCompletion: async () => ({ '9': { gifs: [{ filename: 'o.mp4' }] } }),
      download: async () => Buffer.from('video'),
      uploadImage: async (_d: Buffer, n: string) => n,
      interrupt: async () => {},
    } as unknown as ComfyClient,
    piper: { synthesize: async () => Buffer.from('wav') } as unknown as PiperClient,
    ffmpeg: async (a: string[]) => {
      void a;
    },
    jobs: { workDir: dir, autoStart: false },
  });
}

test('GET /draft/:id/publish returns metadata; 404 unknown; 422 invalid model output', async () => {
  const smart = {
    chatJson: async (opts: { system: string }) => {
      if (opts.system.includes('publication metadata')) return GOOD;
      return { scenes: [{ title: 'a', narration: 'n', visualPrompt: 'v', voice: 'male' }] };
    },
  };
  const app = setupApp(smart);
  const created = await request(app).post('/api/pipeline/draft').send({ text: 'article' });
  assert.equal(created.status, 201);
  const ok = await request(app).get(`/api/pipeline/draft/${created.body.id}/publish`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Un video corto');
  assert.deepEqual(ok.body.hashtags, ['shorts', 'ciencia']);
  const none = await request(app).get('/api/pipeline/draft/missing/publish');
  assert.equal(none.status, 404);

  const bad = {
    chatJson: async (opts: { system: string }) => {
      if (opts.system.includes('publication metadata')) return { no: 'shape' };
      return { scenes: [{ title: 'a', narration: 'n', visualPrompt: 'v', voice: 'male' }] };
    },
  };
  const badApp = setupApp(bad);
  const id = (await request(badApp).post('/api/pipeline/draft').send({ text: 'x' })).body.id as string;
  const badRes = await request(badApp).get(`/api/pipeline/draft/${id}/publish`);
  assert.equal(badRes.status, 422);
});

test('generatePublishMetadata forwards deps.signal to chatJson', async () => {
  let seen: AbortSignal | undefined;
  const ollama = {
    chatJson: async (opts: { signal?: AbortSignal }) => {
      seen = opts.signal;
      return GOOD;
    },
  } as unknown as OllamaClient;
  const ac = new AbortController();
  await generatePublishMetadata({ language: 'es', escaleta }, { ollama, signal: ac.signal });
  assert.equal(seen, ac.signal);
});
