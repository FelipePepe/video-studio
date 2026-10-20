import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACE_STEP_CHECKPOINT,
  buildACEStepMusicWorkflow,
  type Workflow,
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

// Every [node, idx] connection must reference an existing node (link integrity).
function assertConnectionsValid(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v)) {
        assert.equal(v.length, 2, `${id}.${key}`);
        assert.ok(v[0] in wf, `${id}.${key} references missing node ${v[0]}`);
        assert.notEqual(v[0], id, `${id}.${key} self reference`);
      }
    }
  }
}

test('ACE-Step 1.5: uses the *1.5* node family that matches the v1.5 checkpoint', () => {
  const wf = buildACEStepMusicWorkflow({ seed: 1 });

  // The v1.5 encoder + latent nodes (NOT the 1.3.5b `TextEncodeAceStepAudio` /
  // `EmptyAceStepLatentAudio`, which is the mix that broke VAEDecodeAudio validation).
  assert.equal(byType(wf, 'TextEncodeAceStepAudio1.5').length, 1);
  assert.equal(byType(wf, 'EmptyAceStep1.5LatentAudio').length, 1);
  assert.equal(byType(wf, 'TextEncodeAceStepAudio').length, 0, 'no 1.3.5b encoder');
  assert.equal(byType(wf, 'EmptyAceStepLatentAudio').length, 0, 'no 1.3.5b latent');

  // Full chain present.
  for (const t of ['CheckpointLoaderSimple', 'ModelSamplingSD3', 'KSampler', 'VAEDecodeAudio', 'SaveAudio']) {
    assert.ok(byType(wf, t).length >= 1, `missing ${t}`);
  }
  assertConnectionsValid(wf);

  const ckpt = one(wf, 'CheckpointLoaderSimple');
  assert.equal(ckpt.inputs.ckpt_name, ACE_STEP_CHECKPOINT);

  // Flow-matching: the checkpoint model is routed through ModelSamplingSD3 with a shift, and that
  // model feeds the KSampler.
  const sampling = one(wf, 'ModelSamplingSD3');
  assert.deepEqual(sampling.inputs.model, [ckpt.id, 0]);
  assert.equal(sampling.inputs.shift, 4.0);
  const sampler = one(wf, 'KSampler');
  assert.deepEqual(sampler.inputs.model, [sampling.id, 0]);
});

test('ACE-Step 1.5: KSampler carries every required input with reference params', () => {
  const wf = buildACEStepMusicWorkflow({ seed: 123, seconds: 90 });
  const sampler = one(wf, 'KSampler');
  const required = ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'];
  for (const k of required) assert.ok(k in sampler.inputs, `KSampler missing ${k}`);

  // Reference params from the official ACE-Step workflow (shift≈4, euler/sgm_uniform, denoise 1).
  assert.equal(sampler.inputs.steps, 30);
  assert.equal(sampler.inputs.cfg, 6.0);
  assert.equal(sampler.inputs.sampler_name, 'euler');
  assert.equal(sampler.inputs.scheduler, 'sgm_uniform');
  assert.equal(sampler.inputs.denoise, 1.0);
  assert.equal(sampler.inputs.seed, 123);

  // positive -> 1.5 encoder, negative -> ConditioningZeroOut, latent -> 1.5 empty latent.
  const pos = (sampler.inputs.positive as [string, number])[0];
  assert.equal(wf[pos].class_type, 'TextEncodeAceStepAudio1.5');
  const neg = (sampler.inputs.negative as [string, number])[0];
  assert.equal(wf[neg].class_type, 'ConditioningZeroOut');
  const latent = (sampler.inputs.latent_image as [string, number])[0];
  assert.equal(wf[latent].class_type, 'EmptyAceStep1.5LatentAudio');
});

test('ACE-Step 1.5: 1.5 encoder has all required inputs; audio decodes and saves', () => {
  const wf = buildACEStepMusicWorkflow({ seed: 1 });
  const enc = one(wf, 'TextEncodeAceStepAudio1.5');
  for (const k of ['clip', 'tags', 'lyrics', 'seed', 'bpm', 'duration', 'timesignature', 'language', 'keyscale', 'generate_audio_codes', 'cfg_scale', 'temperature', 'top_p', 'top_k', 'min_p']) {
    assert.ok(k in enc.inputs, `encoder missing ${k}`);
  }
  // Clip from the checkpoint's CLIP slot.
  assert.equal(wf[(enc.inputs.clip as [string, number])[0]].class_type, 'CheckpointLoaderSimple');

  const decode = one(wf, 'VAEDecodeAudio');
  assert.equal(wf[(decode.inputs.vae as [string, number])[0]].class_type, 'CheckpointLoaderSimple');
  assert.equal(wf[(decode.inputs.samples as [string, number])[0]].class_type, 'KSampler');
  const save = one(wf, 'SaveAudio');
  assert.equal(wf[(save.inputs.audio as [string, number])[0]].class_type, 'VAEDecodeAudio');

  assert.deepEqual(JSON.parse(JSON.stringify(wf)), wf);
});

test('ACE-Step 1.5: style tags, instrumental lyrics and duration are overridable', () => {
  const wf = buildACEStepMusicWorkflow({
    seed: 1,
    tags: 'dark ambient, sparse piano',
    lyrics: '',
    seconds: 60,
    bpm: 80,
    timesignature: '3',
    language: 'es',
    keyscale: 'A minor',
    filenamePrefix: 'scene_2',
  });
  const enc = one(wf, 'TextEncodeAceStepAudio1.5');
  assert.equal(enc.inputs.tags, 'dark ambient, sparse piano');
  assert.equal(enc.inputs.lyrics, '');
  assert.equal('seconds' in enc.inputs, false);
  assert.equal(enc.inputs.duration, 60);
  assert.equal(enc.inputs.bpm, 80);
  assert.equal(enc.inputs.timesignature, '3');
  assert.equal(enc.inputs.language, 'es');
  assert.equal(enc.inputs.keyscale, 'A minor');
  assert.equal(one(wf, 'EmptyAceStep1.5LatentAudio').inputs.seconds, 60);
  assert.equal(one(wf, 'SaveAudio').inputs.filename_prefix, 'scene_2');
  assertConnectionsValid(wf);
});
