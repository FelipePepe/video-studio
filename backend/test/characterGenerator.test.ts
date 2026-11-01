import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterPrompt, comfyCharacterGenerator } from '../src/characters/characterGenerator';
import type { ComfyClient } from '../src/clients/comfy';

test('buildCharacterPrompt puts the description first and asks for a pure green chroma key', () => {
  const { prompt, negativePrompt } = buildCharacterPrompt('  a grumpy owl professor  ');
  assert.ok(prompt.startsWith('a grumpy owl professor'));
  for (const frag of ['head and shoulders', 'front view', 'red felt lips', 'stitching', '#00FF00', 'no gradient', 'no vignette', 'no shadows', 'no floor']) {
    assert.ok(prompt.toLowerCase().includes(frag.toLowerCase()), `prompt missing "${frag}"`);
  }
  for (const frag of ['blurry', 'low quality', 'deformed', 'text', 'watermark', 'extra characters', 'green clothing', 'green hair', 'green skin', 'shadows on the background', 'gradient background', 'full body', 'hands']) {
    assert.ok(negativePrompt.includes(frag), `negative missing "${frag}"`);
  }
  assert.doesNotMatch(prompt, /muppet|sesame|kermit|disney/i);
});

test('comfyCharacterGenerator submits a Qwen-Image workflow and returns the PNG bytes', async () => {
  let submitted: Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined;
  const comfy = {
    submit: async (wf: typeof submitted) => {
      submitted = wf;
      return 'p1';
    },
    waitForCompletion: async () => ({ '9': { images: [{ filename: 'c.png', subfolder: '', type: 'output' }] } }),
    download: async () => new Uint8Array([1, 2, 3]),
  } as unknown as ComfyClient;
  const gen = comfyCharacterGenerator(() => comfy);
  const out = await gen({ prompt: 'p', negativePrompt: 'n', seed: 5 });
  assert.deepEqual([...out], [1, 2, 3]);
  const types = Object.values(submitted!).map((n) => n.class_type);
  assert.ok(types.includes('UNETLoader') && types.includes('SaveImage'));
  assert.ok(!types.some((t) => t.startsWith('WanVideo')));
  const ks = Object.values(submitted!).find((n) => n.class_type === 'KSampler')!;
  assert.equal(ks.inputs.seed, 5);
});

test('comfyCharacterGenerator throws when ComfyUI returns no image', async () => {
  const comfy = {
    submit: async () => 'p1',
    waitForCompletion: async () => ({}),
    download: async () => new Uint8Array(),
  } as unknown as ComfyClient;
  await assert.rejects(comfyCharacterGenerator(() => comfy)({ prompt: 'p', negativePrompt: 'n', seed: 1 }), /no image/);
});
