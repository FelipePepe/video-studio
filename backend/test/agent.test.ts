import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PipelineAgent,
  PipelineAgentError,
  type PipelineAgentRequest,
  type AgentMode,
} from '../src/pipeline/agent';
import type { ComfyClient } from '../src/clients/comfy';

interface ChatCall {
  url: string;
  body: {
    model?: string;
    stream?: boolean;
    tools?: unknown[];
    messages?: Array<{ role: string; content: string }>;
  };
}

function fakeFetch(handler: (call: ChatCall, calls: ChatCall[]) => unknown | Error, calls: ChatCall[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ChatCall['body'];
    const call: ChatCall = { url: String(url), body };
    calls.push(call);
    const result = handler(call, calls);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function fakeComfy(submit: (workflow: object) => Promise<string> | string) {
  return { host: 'http://comfy:8188', submit: async (w: object) => submit(w) } as unknown as ComfyClient;
}

const workflowT2V = {
  '1': { class_type: 'WanVideoEmptyEmbeds', inputs: { width: 1280, height: 720, num_frames: 81 } },
  '2': { class_type: 'WanVideoSampler', inputs: { steps: 50 } },
};

const baseReq: PipelineAgentRequest = {
  visualPrompt: 'Una ciudad futurista al amanecer',
  seed: 42,
};

function toolResponse(args: unknown) {
  return { message: { role: 'assistant', tool_calls: [{ function: { name: 'submit_workflow', arguments: args } }] } };
}

test('generate uses Ollama /api/chat with tools and returns the first submit_workflow call (t2v)', async () => {
  const calls: ChatCall[] = [];
  const agent = new PipelineAgent({
    host: 'http://ollama:11434',
    model: 'test-model',
    fetchImpl: fakeFetch(() => toolResponse({ workflow: workflowT2V, mode: 't2v' }), calls),
    comfy: fakeComfy(async (w) => {
      assert.deepEqual(w, workflowT2V);
      return 'prompt-123';
    }),
  });

  const result = await agent.generate(baseReq);
  assert.deepEqual(result, { promptId: 'prompt-123', mode: 't2v' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://ollama:11434/api/chat');
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].body.stream, false);
  const tool = calls[0].body.tools?.[0] as Record<string, unknown> | undefined;
  assert.equal((tool?.['function'] as Record<string, unknown>)?.['name'], 'submit_workflow');
  const system = calls[0].body.messages?.[0];
  assert.equal(system?.role, 'system');
  // The system prompt must encode the Wan2.2 know-how from the Atlas note.
  for (const needle of [
    'wan_2.1_vae.safetensors',
    'bf16',
    'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
    'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
    'umt5-xxl-enc-fp8_e4m3fn-fixed.safetensors',
    '81',
    '1280',
    '720',
    'unipc',
    'end_image',
  ]) {
    assert.ok(system!.content.includes(needle), `system prompt missing: ${needle}`);
  }
  const user = calls[0].body.messages?.[1];
  assert.equal(user?.role, 'user');
  assert.ok(user!.content.includes('Una ciudad futurista al amanecer'));
  assert.ok(user!.content.includes('42'));
});

test('generate supports i2v mode and passes the workflow through to comfy.submit', async () => {
  const agent = new PipelineAgent({
    host: 'http://ollama:11434',
    fetchImpl: fakeFetch(() => toolResponse({ workflow: workflowT2V, mode: 'i2v' }), []),
    comfy: fakeComfy(async () => 'prompt-i2v'),
  });
  const result = await agent.generate({ ...baseReq, startImage: 'still.png', endImage: 'next.png' });
  assert.deepEqual(result, { promptId: 'prompt-i2v', mode: 'i2v' });
});

test('generate uses the OLLAMA_MODEL env chain and a default when unset', async () => {
  const captured: ChatCall[] = [];
  const model = process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_MODEL;
  try {
    const calls: ChatCall[] = [];
    const agent = new PipelineAgent({
      host: 'http://ollama:11434',
      fetchImpl: fakeFetch(() => toolResponse({ workflow: workflowT2V, mode: 't2v' }), calls),
      comfy: fakeComfy(async () => 'p'),
    });
    await agent.generate(baseReq);
    assert.equal(calls[0].body.model, 'gemma4:26b');
    void captured;
  } finally {
    if (model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = model;
  }
});

test('generate rejects when the model does not call submit_workflow', async () => {
  const agent = new PipelineAgent({
    host: 'http://ollama:11434',
    fetchImpl: fakeFetch(() => ({ message: { role: 'assistant', content: 'sin tool call' } }), []),
    comfy: fakeComfy(async () => 'p'),
  });
  await assert.rejects(() => agent.generate(baseReq), (e: unknown) => {
    assert.ok(e instanceof PipelineAgentError);
    assert.match(String(e.message), /submit_workflow|tool call/i);
    return true;
  });
});

test('generate rejects an unknown mode in the tool arguments', async () => {
  const agent = new PipelineAgent({
    host: 'http://ollama:11434',
    fetchImpl: fakeFetch(() => toolResponse({ workflow: workflowT2V, mode: 'v2v' }), []),
    comfy: fakeComfy(async () => 'p'),
  });
  await assert.rejects(() => agent.generate(baseReq), (e: unknown) => {
    assert.ok(e instanceof PipelineAgentError);
    return true;
  });
});

test('generate rejects an empty or non-object workflow', async () => {
  for (const bad of [{ workflow: {}, mode: 't2v' }, { workflow: 'nope', mode: 't2v' }]) {
    const agent = new PipelineAgent({
      host: 'http://ollama:11434',
      fetchImpl: fakeFetch(() => toolResponse(bad), []),
      comfy: fakeComfy(async () => 'p'),
    });
    await assert.rejects(() => agent.generate(baseReq), (e: unknown) => e instanceof PipelineAgentError);
  }
});

test('generate tolerates tool arguments delivered as a JSON string', async () => {
  const agent = new PipelineAgent({
    host: 'http://ollama:11434',
    fetchImpl: fakeFetch(() => ({ message: { role: 'assistant', tool_calls: [{ function: { name: 'submit_workflow', arguments: JSON.stringify({ workflow: workflowT2V, mode: 'i2v' }) } }] } }), []),
    comfy: fakeComfy(async (w) => {
      assert.deepEqual(w, workflowT2V);
      return 'p-string';
    }),
  });
  const result = await agent.generate(baseReq);
  assert.deepEqual(result, { promptId: 'p-string', mode: 'i2v' satisfies AgentMode });
});

test('generate propagates ComfyUI submit failures', async () => {
  const agent = new PipelineAgent({
    host: 'http://ollama:11434',
    fetchImpl: fakeFetch(() => toolResponse({ workflow: workflowT2V, mode: 't2v' }), []),
    comfy: fakeComfy(async () => {
      throw new Error('ComfyUI /prompt failed: 500 oops');
    }),
  });
  await assert.rejects(() => agent.generate(baseReq), /ComfyUI \/prompt failed/);
});

test('generate surfaces an unreachable Ollama host', async () => {
  const agent = new PipelineAgent({
    host: 'http://no-such-host:11434',
    fetchImpl: (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch,
    comfy: fakeComfy(async () => 'p'),
  });
  await assert.rejects(() => agent.generate(baseReq), /Ollama unreachable at http:\/\/no-such-host:11434/);
});
