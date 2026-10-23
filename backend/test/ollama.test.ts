import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaClient } from '../src/clients/ollama';

function fakeFetch(res: Response | Error) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const reply = (content: string) => new Response(JSON.stringify({ message: { role: 'assistant', content } }));

test('chatJson posts a non-streaming json chat and parses message.content', async () => {
  const { fetchImpl, calls } = fakeFetch(reply('{"a":1}'));
  const client = new OllamaClient('http://o:11434', { fetchImpl, model: 'm1' });
  const out = await client.chatJson<{ a: number }>({ system: 'sys', user: 'usr' });
  assert.deepEqual(out, { a: 1 });
  assert.equal(calls[0].url, 'http://o:11434/api/chat');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    model: 'm1',
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ],
  });
});

test('per-call model overrides the client model', async () => {
  const { fetchImpl, calls } = fakeFetch(reply('{}'));
  await new OllamaClient('http://o', { fetchImpl, model: 'm1' }).chatJson({ system: 's', user: 'u', model: 'm2' });
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, 'm2');
});

test('model defaults to OLLAMA_MODEL env then gemma4:26b', async () => {
  const prev = process.env.OLLAMA_MODEL;
  try {
    delete process.env.OLLAMA_MODEL;
    let f = fakeFetch(reply('{}'));
    await new OllamaClient('http://o', { fetchImpl: f.fetchImpl }).chatJson({ system: 's', user: 'u' });
    assert.equal(JSON.parse(String(f.calls[0].init?.body)).model, 'gemma4:26b');
    process.env.OLLAMA_MODEL = 'llama3';
    f = fakeFetch(reply('{}'));
    await new OllamaClient('http://o', { fetchImpl: f.fetchImpl }).chatJson({ system: 's', user: 'u' });
    assert.equal(JSON.parse(String(f.calls[0].init?.body)).model, 'llama3');
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = prev;
  }
});

test('numCtx option is sent as options.num_ctx', async () => {
  const { fetchImpl, calls } = fakeFetch(reply('{}'));
  await new OllamaClient('http://o', { fetchImpl, numCtx: 16384 }).chatJson({ system: 's', user: 'u' });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)).options, { num_ctx: 16384 });
});

test('num_ctx falls back to OLLAMA_NUM_CTX and ignores invalid values', async () => {
  const prev = process.env.OLLAMA_NUM_CTX;
  const bodyFor = async (opts: { numCtx?: number } = {}) => {
    const f = fakeFetch(reply('{}'));
    await new OllamaClient('http://o', { fetchImpl: f.fetchImpl, ...opts }).chatJson({ system: 's', user: 'u' });
    return JSON.parse(String(f.calls[0].init?.body));
  };
  try {
    process.env.OLLAMA_NUM_CTX = '8192';
    assert.deepEqual((await bodyFor()).options, { num_ctx: 8192 });
    assert.deepEqual((await bodyFor({ numCtx: 4096 })).options, { num_ctx: 4096 });
    for (const bad of ['abc', '0', '-5', '1.5', '']) {
      process.env.OLLAMA_NUM_CTX = bad;
      assert.equal('options' in (await bodyFor()), false, `ignored: "${bad}"`);
    }
    delete process.env.OLLAMA_NUM_CTX;
    assert.equal('options' in (await bodyFor()), false);
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_NUM_CTX;
    else process.env.OLLAMA_NUM_CTX = prev;
  }
});

test('passes the abort signal to fetch', async () => {
  const { fetchImpl, calls } = fakeFetch(reply('{}'));
  const ac = new AbortController();
  await new OllamaClient('http://o', { fetchImpl }).chatJson({ system: 's', user: 'u', signal: ac.signal });
  assert.equal(calls[0].init?.signal, ac.signal);
});

test('throws on non-JSON content, non-2xx and network errors', async () => {
  await assert.rejects(
    new OllamaClient('http://o', { fetchImpl: fakeFetch(reply('not json')).fetchImpl }).chatJson({ system: 's', user: 'u' }),
    /not valid JSON/,
  );
  await assert.rejects(
    new OllamaClient('http://o', { fetchImpl: fakeFetch(new Response('model missing', { status: 404 })).fetchImpl }).chatJson({ system: 's', user: 'u' }),
    /404.*model missing/,
  );
  await assert.rejects(
    new OllamaClient('http://o', { fetchImpl: fakeFetch(new Error('ECONNREFUSED')).fetchImpl }).chatJson({ system: 's', user: 'u' }),
    /Ollama unreachable.*ECONNREFUSED/,
  );
});

test('throws when the response has no message content', async () => {
  const { fetchImpl } = fakeFetch(new Response('{}'));
  await assert.rejects(new OllamaClient('http://o', { fetchImpl }).chatJson({ system: 's', user: 'u' }), /no message content/);
});
