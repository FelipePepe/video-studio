import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  I2V_MODEL,
  T2V_MODEL,
  T5_ENCODER,
  WAN_VAE,
  buildI2VWorkflow,
  buildT2VWorkflow,
  type Workflow,
} from '../src/comfy/workflows';

function byType(wf: Workflow, type: string) {
  return Object.entries(wf)
    .filter(([, n]) => n.class_type === type)
    .map(([id, n]) => ({ id, ...n }));
}

function one(wf: Workflow, type: string) {
  const nodes = byType(wf, type);
  assert.equal(nodes.length, 1, `expected exactly one ${type}`);
  return nodes[0];
}

function assertConnectionsValid(wf: Workflow) {
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

test('constants match the ComfyUI note', () => {
  assert.equal(WAN_VAE, 'wan_2.1_vae.safetensors');
  assert.equal(T2V_MODEL, 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors');
  assert.equal(I2V_MODEL, 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors');
  assert.equal(T5_ENCODER, 'umt5-xxl-enc-fp8_e4m3fn-fixed.safetensors');
  assert.deepEqual(DEFAULTS, {
    width: 1280, height: 720, numFrames: 81, steps: 50, cfg: 6.0, shift: 5.0,
    scheduler: 'unipc', blockSwap: 20, fps: 16,
  });
});

for (const [name, build] of [
  ['T2V', () => buildT2VWorkflow({ prompt: 'p', seed: 1 })],
  ['I2V', () => buildI2VWorkflow({ prompt: 'p', seed: 1, startImage: 'a.png' })],
  ['I2V with end image', () => buildI2VWorkflow({ prompt: 'p', seed: 1, startImage: 'a.png', endImage: 'b.png' })],
] as const) {
  test(`${name}: ids unique strings, connections valid, VAE rule, save_output`, () => {
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
  });
}

test('T2V: seed, prompt, size, frames land in the right inputs with defaults', () => {
  const wf = buildT2VWorkflow({ prompt: 'a cat', negativePrompt: 'blurry', seed: 42 });
  const text = one(wf, 'WanVideoTextEncode');
  assert.equal(text.inputs.positive_prompt, 'a cat');
  assert.equal(text.inputs.negative_prompt, 'blurry');
  const sampler = one(wf, 'WanVideoSampler');
  assert.equal(sampler.inputs.seed, 42);
  assert.equal(sampler.inputs.steps, 50);
  assert.equal(sampler.inputs.cfg, 6.0);
  assert.equal(sampler.inputs.shift, 5.0);
  assert.equal(sampler.inputs.scheduler, 'unipc');
  const empty = one(wf, 'WanVideoEmptyEmbeds');
  assert.deepEqual([empty.inputs.width, empty.inputs.height, empty.inputs.num_frames], [1280, 720, 81]);
  assert.deepEqual(sampler.inputs.image_embeds, [empty.id, 0]);
  assert.equal(one(wf, 'WanVideoModelLoader').inputs.model, T2V_MODEL);
  assert.equal(one(wf, 'WanVideoBlockSwap').inputs.blocks_to_swap, 20);
  assert.equal(one(wf, 'VHS_VideoCombine').inputs.frame_rate, 16);
  assert.equal(byType(wf, 'LoadImage').length, 0);
});

test('T2V: overrides apply and sampler chain is wired per the note', () => {
  const wf = buildT2VWorkflow({
    prompt: 'x', seed: 7, width: 832, height: 480, numFrames: 49, steps: 20, filenamePrefix: 'seg_1',
  });
  const empty = one(wf, 'WanVideoEmptyEmbeds');
  assert.deepEqual([empty.inputs.width, empty.inputs.height, empty.inputs.num_frames], [832, 480, 49]);
  assert.equal(one(wf, 'WanVideoSampler').inputs.steps, 20);
  assert.equal(one(wf, 'VHS_VideoCombine').inputs.filename_prefix, 'seg_1');
  const loader = one(wf, 'WanVideoModelLoader');
  const swap = one(wf, 'WanVideoSetBlockSwap');
  const loras = one(wf, 'WanVideoSetLoRAs');
  const sampler = one(wf, 'WanVideoSampler');
  const decode = one(wf, 'WanVideoDecode');
  const combine = one(wf, 'VHS_VideoCombine');
  const text = one(wf, 'WanVideoTextEncode');
  assert.deepEqual(swap.inputs.model, [loader.id, 0]);
  assert.deepEqual(swap.inputs.block_swap_args, [one(wf, 'WanVideoBlockSwap').id, 0]);
  assert.deepEqual(loras.inputs.model, [swap.id, 0]);
  assert.deepEqual(sampler.inputs.model, [loras.id, 0]);
  assert.deepEqual(sampler.inputs.text_embeds, [text.id, 0]);
  assert.deepEqual(text.inputs.t5, [one(wf, 'LoadWanVideoT5TextEncoder').id, 0]);
  assert.deepEqual(decode.inputs.samples, [sampler.id, 0]);
  assert.deepEqual(decode.inputs.vae, [one(wf, 'WanVideoVAELoader').id, 0]);
  assert.deepEqual(combine.inputs.images, [decode.id, 0]);
});

test('I2V without endImage omits end_image and creates a single LoadImage/resize', () => {
  const wf = buildI2VWorkflow({ prompt: 'p', seed: 3, startImage: 'start.png' });
  const enc = one(wf, 'WanVideoImageToVideoEncode');
  assert.equal('end_image' in enc.inputs, false);
  assert.equal(byType(wf, 'LoadImage').length, 1);
  assert.equal(byType(wf, 'WanVideoImageResizeToClosest').length, 1);
  assert.equal(byType(wf, 'WanVideoEmptyEmbeds').length, 0);
  assert.equal(one(wf, 'LoadImage').inputs.image, 'start.png');
  assert.equal(one(wf, 'WanVideoModelLoader').inputs.model, I2V_MODEL);
  const resize = one(wf, 'WanVideoImageResizeToClosest');
  assert.deepEqual(enc.inputs.start_image, [resize.id, 0]);
  assert.deepEqual(resize.inputs.image, [one(wf, 'LoadImage').id, 0]);
  assert.equal(resize.inputs.generation_width, 1280);
  assert.equal(resize.inputs.generation_height, 720);
  assert.deepEqual(one(wf, 'WanVideoSampler').inputs.image_embeds, [enc.id, 0]);
  assert.deepEqual(enc.inputs.vae, [one(wf, 'WanVideoVAELoader').id, 0]);
});

test('I2V with endImage adds a second LoadImage and resize wired to end_image', () => {
  const wf = buildI2VWorkflow({ prompt: 'p', seed: 3, startImage: 'a.png', endImage: 'b.png', width: 832, height: 480 });
  const loads = byType(wf, 'LoadImage');
  assert.deepEqual(loads.map((n) => n.inputs.image).sort(), ['a.png', 'b.png']);
  assert.equal(byType(wf, 'WanVideoImageResizeToClosest').length, 2);
  const enc = one(wf, 'WanVideoImageToVideoEncode');
  const end = wf[(enc.inputs.end_image as [string, number])[0]];
  const start = wf[(enc.inputs.start_image as [string, number])[0]];
  assert.equal(end.class_type, 'WanVideoImageResizeToClosest');
  assert.notDeepEqual(enc.inputs.end_image, enc.inputs.start_image);
  assert.equal(wf[(end.inputs.image as [string, number])[0]].inputs.image, 'b.png');
  assert.equal(wf[(start.inputs.image as [string, number])[0]].inputs.image, 'a.png');
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
