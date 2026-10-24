import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaClient, OllamaTimeoutError } from '../src/clients/ollama';

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
    keep_alive: '0s',
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

test('keep_alive defaults to "0s" so the model is released after the escaleta (frees VRAM for ComfyUI)', async () => {
  const prev = process.env.OLLAMA_KEEP_ALIVE;
  try {
    delete process.env.OLLAMA_KEEP_ALIVE;
    const { fetchImpl, calls } = fakeFetch(reply('{}'));
    await new OllamaClient('http://o', { fetchImpl }).chatJson({ system: 's', user: 'u' });
    assert.equal(JSON.parse(String(calls[0].init?.body)).keep_alive, '0s');
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_KEEP_ALIVE;
    else process.env.OLLAMA_KEEP_ALIVE = prev;
  }
});

test('keepAlive option and OLLAMA_KEEP_ALIVE override the default keep_alive', async () => {
  const prev = process.env.OLLAMA_KEEP_ALIVE;
  const bodyFor = async (opts: { keepAlive?: string } = {}) => {
    const f = fakeFetch(reply('{}'));
    await new OllamaClient('http://o', { fetchImpl: f.fetchImpl, ...opts }).chatJson({ system: 's', user: 'u' });
    return JSON.parse(String(f.calls[0].init?.body));
  };
  try {
    assert.equal((await bodyFor()).keep_alive, '0s', 'default when unset');
    process.env.OLLAMA_KEEP_ALIVE = '5m';
    assert.equal((await bodyFor()).keep_alive, '5m', 'env wins');
    assert.equal((await bodyFor({ keepAlive: '1m' })).keep_alive, '1m', 'option wins over env');
    process.env.OLLAMA_KEEP_ALIVE = '   ';
    assert.equal((await bodyFor()).keep_alive, '0s', 'blank env ignored');
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_KEEP_ALIVE;
    else process.env.OLLAMA_KEEP_ALIVE = prev;
  }
});

test('passes an abortable signal to fetch that follows the caller signal', async () => {
  let sent: AbortSignal | undefined;
  const fetchImpl = ((_u: unknown, init?: RequestInit) => {
    sent = init?.signal as AbortSignal;
    return new Promise(() => undefined);
  }) as typeof fetch;
  const ac = new AbortController();
  void new OllamaClient('http://o', { fetchImpl }).chatJson({ system: 's', user: 'u', signal: ac.signal }).catch(() => undefined);
  assert.equal(sent?.aborted, false);
  ac.abort();
  assert.equal(sent?.aborted, true);
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

/** Fake fetch that never answers until its signal aborts, like a hung Ollama. */
function hangingFetch(): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const fail = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    })) as typeof fetch;
}

async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('chatJson aborts a hung request after timeoutMs with a timeout error', async () => {
  const client = new OllamaClient('http://o', { fetchImpl: hangingFetch(), timeoutMs: 20 });
  await assert.rejects(client.chatJson({ system: 's', user: 'u' }), (e: Error) => {
    assert.ok(e instanceof OllamaTimeoutError);
    assert.match(e.message, /timed out after 20ms/);
    return true;
  });
});

test('chatJson reports a caller abort as an abort, not as a timeout or unreachable', async () => {
  const client = new OllamaClient('http://o', { fetchImpl: hangingFetch(), timeoutMs: 5000 });
  const ac = new AbortController();
  const p = client.chatJson({ system: 's', user: 'u', signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: Error) => {
    assert.equal(e.name, 'AbortError');
    assert.ok(!(e instanceof OllamaTimeoutError));
    assert.doesNotMatch(e.message, /timed out|unreachable/);
    return true;
  });
});

test('timeoutMs option wins over OLLAMA_TIMEOUT_MS; invalid or empty env falls back to 300000', async () => {
  const seen = (opt: number | undefined) => new OllamaClient('http://o', { fetchImpl: hangingFetch(), timeoutMs: opt });
  // Use tiny values so the timeout actually fires and names the effective value.
  await withEnv('OLLAMA_TIMEOUT_MS', '30', async () => {
    await assert.rejects(seen(undefined).chatJson({ system: 's', user: 'u' }), /timed out after 30ms/);
    await assert.rejects(seen(15).chatJson({ system: 's', user: 'u' }), /timed out after 15ms/);
  });
  for (const bad of ['', 'abc', '0', '-5']) {
    await withEnv('OLLAMA_TIMEOUT_MS', bad, async () => {
      const ac = new AbortController();
      const p = seen(undefined).chatJson({ system: 's', user: 'u', signal: ac.signal });
      ac.abort();
      await assert.rejects(p, (e: Error) => e.name === 'AbortError', `env ${JSON.stringify(bad)} must not fire early`);
    });
  }
});

test('default chat timeout is 300000ms when nothing is configured', async () => {
  await withEnv('OLLAMA_TIMEOUT_MS', undefined, async () => {
    const { fetchImpl, calls } = fakeFetch(reply('{}'));
    const orig = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
      delays.push(ms ?? 0);
      return orig(fn, ms, ...a);
    }) as typeof setTimeout;
    try {
      await new OllamaClient('http://o', { fetchImpl }).chatJson({ system: 's', user: 'u' });
    } finally {
      globalThis.setTimeout = orig;
    }
    assert.ok(delays.includes(300000), `delays: ${delays}`);
    assert.equal(calls.length, 1);
  });
});

test('listModels honours a caller signal', async () => {
  const client = new OllamaClient('http://o', { fetchImpl: hangingFetch() });
  const ac = new AbortController();
  const p = client.listModels({ signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: Error) => e.name === 'AbortError' && !(e instanceof OllamaTimeoutError));
});

test('listModels times out via tagsTimeoutMs option and OLLAMA_TAGS_TIMEOUT_MS env', async () => {
  await assert.rejects(
    new OllamaClient('http://o', { fetchImpl: hangingFetch(), tagsTimeoutMs: 20 }).listModels(),
    (e: Error) => e instanceof OllamaTimeoutError && /timed out after 20ms/.test(e.message),
  );
  await withEnv('OLLAMA_TAGS_TIMEOUT_MS', '25', async () => {
    await assert.rejects(
      new OllamaClient('http://o', { fetchImpl: hangingFetch() }).listModels(),
      /timed out after 25ms/,
    );
  });
});
