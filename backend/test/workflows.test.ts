import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  I2V_LOW_MODEL,
  I2V_MODEL,
  T2V_LOW_MODEL,
  T2V_MODEL,
  T5_ENCODER,
  WAN_VAE,
  buildI2VWorkflow,
  buildT2VWorkflow,
  type Workflow,
  type WorkflowNode,
} from '../src/comfy/workflows';

type AnyNode = { id: string } & Workflow[string];

function byType(wf: Workflow, type: string): AnyNode[] {
  return Object.entries(wf)
    .filter(([, n]) => n.class_type === type)
    .map(([id, n]) => ({ id, ...n }));
}

function one(wf: Workflow, type: string): AnyNode {
  const nodes = byType(wf, type);
  assert.equal(nodes.length, 1, `expected exactly one ${type}`);
  return nodes[0];
}

// The dual-expert chain emits exactly two WanVideoSamplers. The high-noise expert opens the
// step range and carries NO `samples` input; the low-noise expert continues from that latent, so
// it is the one that HAS a `samples` connection.
function samplerPair(wf: Workflow): { high: AnyNode; low: AnyNode } {
  const all = byType(wf, 'WanVideoSampler');
  assert.equal(all.length, 2, 'expected exactly two WanVideoSamplers (high + low noise)');
  const low = all.find((n) => Array.isArray(n.inputs.samples));
  const high = all.find((n) => !Array.isArray(n.inputs.samples));
  if (!high || !low) throw new Error('could not identify the high/low sampler pair');
  return { high, low };
}

function assertConnectionsValid(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v)) {
        assert.equal(v.length, 2, `${id}.${key}`);
        assert.equal(typeof v[0], 'string', `${id}.${key} source id must be a string`);
        assert.equal(typeof v[1], 'number');
        assert.ok(v[0] in wf, `${id}.${key} references missing node ${v[0]}`);
        assert.notEqual(v[0], id, `${id}.${key} self reference`);
      }
    }
  }
}

function conn(wf: Workflow, node: WorkflowNode, key: string): string {
  const value = node.inputs[key] as [string, number] | undefined;
  assert.ok(Array.isArray(value), `${key} should be a connection`);
  assert.ok(value[0] in wf, `${key} references missing node ${value[0]}`);
  return value[0];
}

function assertSwapChain(wf: Workflow, lorasNode: WorkflowNode): void {
  const swap = wf[conn(wf, lorasNode, 'model')];
  assert.equal(swap.class_type, 'WanVideoSetBlockSwap');
  assert.equal((swap.inputs.block_swap_args as [string, number])[1], 0);
  const blockSwap = wf[conn(wf, swap, 'block_swap_args')];
  assert.equal(blockSwap.class_type, 'WanVideoBlockSwap');
  assert.equal(blockSwap.inputs.blocks_to_swap, 20);
  const loadedModel = wf[conn(wf, swap, 'model')];
  assert.equal(loadedModel.class_type, 'WanVideoModelLoader');
}

test('constants match the ComfyUI note', () => {
  assert.equal(WAN_VAE, 'wan_2.1_vae.safetensors');
  assert.equal(T2V_MODEL, 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors');
  assert.equal(T2V_LOW_MODEL, 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors');
  assert.equal(I2V_MODEL, 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors');
  assert.equal(I2V_LOW_MODEL, 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors');
  assert.equal(T5_ENCODER, 'umt5-xxl-enc-fp8_e4m3fn-fixed.safetensors');
  assert.deepEqual(DEFAULTS, {
    width: 1280, height: 720, numFrames: 81, steps: 50, switchStep: 42,
    cfg: 6.0, shift: 5.0, scheduler: 'unipc', blockSwap: 20, fps: 16,
  });
});

for (const [name, build] of [
  ['T2V', () => buildT2VWorkflow({ prompt: 'p', seed: 1 })],
  ['I2V', () => buildI2VWorkflow({ prompt: 'p', seed: 1, startImage: 'a.png' })],
  ['I2V with end image', () => buildI2VWorkflow({ prompt: 'p', seed: 1, startImage: 'a.png', endImage: 'b.png' })],
] as const) {
  test(`${name}: ids unique, connections valid, VAE rule, save_output, dual-expert chain`, () => {
    const wf = build();
    const ids = Object.keys(wf);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^\d+$/);
    assertConnectionsValid(wf);

    const vae = one(wf, 'WanVideoVAELoader');
    assert.equal(vae.inputs.model_name, 'wan_2.1_vae.safetensors');
    assert.equal(vae.inputs.precision, 'bf16');
    assert.ok(!JSON.stringify(wf).includes('wan2.2_vae'));
    assert.equal(one(wf, 'VHS_VideoCombine').inputs.save_output, true);
    assert.equal(byType(wf, 'WanVideoSamplerv2').length, 0);

    // Two experts on two different models, one text embedding and one VAE shared across both.
    assert.equal(byType(wf, 'WanVideoModelLoader').length, 2);
    assert.equal(byType(wf, 'WanVideoTextEncode').length, 1);
    assert.equal(vae.id, byType(wf, 'WanVideoVAELoader')[0].id);

    // The step range is split: high opens it, low finishes from the high latent.
    const { high, low } = samplerPair(wf);
    assert.equal(high.inputs.start_step, 0);
    assert.equal(high.inputs.end_step, DEFAULTS.switchStep);
    assert.equal(low.inputs.start_step, DEFAULTS.switchStep);
    assert.equal(low.inputs.end_step, -1);
    assert.deepEqual(low.inputs.samples, [high.id, 0]);

    // Decode and combine hang off the low-noise (last) sampler's output.
    const decode = one(wf, 'WanVideoDecode');
    assert.deepEqual(decode.inputs.samples, [low.id, 0]);
    assert.deepEqual(decode.inputs.vae, [vae.id, 0]);
    assert.deepEqual(one(wf, 'VHS_VideoCombine').inputs.images, [decode.id, 0]);
  });
}

test('T2V: seed, prompt, size, frames land in the right inputs with defaults', () => {
  const wf = buildT2VWorkflow({ prompt: 'a cat', negativePrompt: 'blurry', seed: 42 });
  const text = one(wf, 'WanVideoTextEncode');
  assert.equal(text.inputs.positive_prompt, 'a cat');
  assert.equal(text.inputs.negative_prompt, 'blurry');
  assert.deepEqual(text.inputs.t5, [one(wf, 'LoadWanVideoT5TextEncoder').id, 0]);
  const { high, low } = samplerPair(wf);
  for (const s of [high, low]) {
    assert.equal(s.inputs.seed, 42);
    assert.equal(s.inputs.steps, 50);
    assert.equal(s.inputs.cfg, 6.0);
    assert.equal(s.inputs.shift, 5.0);
    assert.equal(s.inputs.scheduler, 'unipc');
    assert.deepEqual(s.inputs.text_embeds, [text.id, 0]);
  }
  const empty = one(wf, 'WanVideoEmptyEmbeds');
  assert.deepEqual([empty.inputs.width, empty.inputs.height, empty.inputs.num_frames], [1280, 720, 81]);
  assert.deepEqual(high.inputs.image_embeds, [empty.id, 0]);
  assert.deepEqual(low.inputs.image_embeds, [empty.id, 0]);
  // Both high- and low-noise T2V experts are loaded.
  assert.deepEqual(
    byType(wf, 'WanVideoModelLoader').map((n) => n.inputs.model).sort(),
    [T2V_LOW_MODEL, T2V_MODEL].sort(),
  );
  // One swap chain per model.
  assert.equal(byType(wf, 'WanVideoBlockSwap').length, 2);
  assert.equal(byType(wf, 'WanVideoSetBlockSwap').length, 2);
  assert.equal(byType(wf, 'WanVideoSetLoRAs').length, 2);
  assert.equal(one(wf, 'VHS_VideoCombine').inputs.frame_rate, 16);
  assert.equal(byType(wf, 'LoadImage').length, 0);
});

test('T2V: overrides apply and each model chain is wired correctly', () => {
  const wf = buildT2VWorkflow({
    prompt: 'x', seed: 7, width: 832, height: 480, numFrames: 49, steps: 20, switchStep: 12, filenamePrefix: 'seg_1',
  });
  const empty = one(wf, 'WanVideoEmptyEmbeds');
  assert.deepEqual([empty.inputs.width, empty.inputs.height, empty.inputs.num_frames], [832, 480, 49]);
  const { high, low } = samplerPair(wf);
  assert.equal(high.inputs.steps, 20);
  assert.equal(low.inputs.steps, 20);
  assert.equal(high.inputs.end_step, 12);
  assert.equal(low.inputs.start_step, 12);
  assert.deepEqual(low.inputs.samples, [high.id, 0]);
  assert.equal(one(wf, 'VHS_VideoCombine').inputs.filename_prefix, 'seg_1');

  // Each sampler takes its own loras; the two chains are distinct and each is loader -> loras.
  const highLoras = conn(wf, high, 'model');
  const lowLoras = conn(wf, low, 'model');
  assert.notEqual(highLoras, lowLoras);
  assertSwapChain(wf, wf[highLoras]);
  assertSwapChain(wf, wf[lowLoras]);

  // Decode and combine hang off the low-noise sampler.
  const decode = one(wf, 'WanVideoDecode');
  assert.deepEqual(decode.inputs.samples, [low.id, 0]);
  assert.deepEqual(decode.inputs.vae, [one(wf, 'WanVideoVAELoader').id, 0]);
  assert.deepEqual(one(wf, 'VHS_VideoCombine').inputs.images, [decode.id, 0]);
});

test('I2V without endImage omits end_image and creates a single LoadImage/resize', () => {
  const wf = buildI2VWorkflow({ prompt: 'p', seed: 3, startImage: 'start.png' });
  const enc = one(wf, 'WanVideoImageToVideoEncode');
  assert.equal('end_image' in enc.inputs, false);
  assert.equal(byType(wf, 'LoadImage').length, 1);
  assert.equal(byType(wf, 'WanVideoImageResizeToClosest').length, 1);
  assert.equal(byType(wf, 'WanVideoEmptyEmbeds').length, 0);
  assert.equal(one(wf, 'LoadImage').inputs.image, 'start.png');
  // Both high- and low-noise I2V experts are loaded.
  assert.deepEqual(
    byType(wf, 'WanVideoModelLoader').map((n) => n.inputs.model).sort(),
    [I2V_LOW_MODEL, I2V_MODEL].sort(),
  );
  const resize = one(wf, 'WanVideoImageResizeToClosest');
  assert.deepEqual(enc.inputs.start_image, [resize.id, 0]);
  assert.deepEqual(resize.inputs.image, [one(wf, 'LoadImage').id, 0]);
  assert.equal(resize.inputs.generation_width, 1280);
  assert.equal(resize.inputs.generation_height, 720);
  const { high, low } = samplerPair(wf);
  assert.deepEqual(high.inputs.image_embeds, [enc.id, 0]);
  assert.deepEqual(low.inputs.image_embeds, [enc.id, 0]);
  assert.deepEqual(enc.inputs.vae, [one(wf, 'WanVideoVAELoader').id, 0]);
});

test('I2V with endImage adds a second LoadImage and resize wired to end_image', () => {
  const wf = buildI2VWorkflow({ prompt: 'p', seed: 3, startImage: 'a.png', endImage: 'b.png', width: 832, height: 480 });
  const loads = byType(wf, 'LoadImage');
  assert.deepEqual(loads.map((n) => n.inputs.image).sort(), ['a.png', 'b.png']);
  assert.equal(byType(wf, 'WanVideoImageResizeToClosest').length, 2);
  const enc = one(wf, 'WanVideoImageToVideoEncode');
  const endId = conn(wf, enc, 'end_image');
  const startId = conn(wf, enc, 'start_image');
  assert.equal(wf[endId].class_type, 'WanVideoImageResizeToClosest');
  assert.notEqual(endId, startId);
  assert.equal(wf[conn(wf, wf[endId], 'image')].inputs.image, 'b.png');
  assert.equal(wf[conn(wf, wf[startId], 'image')].inputs.image, 'a.png');
  assert.deepEqual([enc.inputs.width, enc.inputs.height, enc.inputs.num_frames], [832, 480, 81]);
  assert.equal(enc.inputs.noise_aug_strength, 0.0);
  assert.equal(enc.inputs.start_latent_strength, 1.0);
  assert.equal(enc.inputs.end_latent_strength, 1.0);
});

test('workflow is JSON-serializable without undefined values', () => {
  const wf = buildI2VWorkflow({ prompt: 'p', seed: 1, startImage: 'a.png' });
  assert.deepEqual(JSON.parse(JSON.stringify(wf)), wf);
});

test('pingpong defaults to true and can be disabled for T2V and I2V', () => {
  const t2v = { prompt: 'p', seed: 1 };
  const i2v = { ...t2v, startImage: 'a.png' };
  assert.equal(one(buildT2VWorkflow(t2v), 'VHS_VideoCombine').inputs.pingpong, true);
  assert.equal(one(buildI2VWorkflow(i2v), 'VHS_VideoCombine').inputs.pingpong, true);
  assert.equal(one(buildT2VWorkflow({ ...t2v, pingpong: false }), 'VHS_VideoCombine').inputs.pingpong, false);
  assert.equal(one(buildI2VWorkflow({ ...i2v, pingpong: false }), 'VHS_VideoCombine').inputs.pingpong, false);
});
