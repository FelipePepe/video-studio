import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyClient, extractOutputFile, extractVideoOutput } from '../src/clients/comfy';

type Call = { url: string; init?: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test('submit posts the workflow and returns prompt_id', async () => {
  const { fetchImpl, calls } = fakeFetch([json({ prompt_id: 'abc' })]);
  const client = new ComfyClient('http://comfy:8188', { fetchImpl });
  const id = await client.submit({ '1': { class_type: 'X', inputs: {} } });
  assert.equal(id, 'abc');
  assert.equal(calls[0].url, 'http://comfy:8188/prompt');
  assert.equal(calls[0].init?.method, 'POST');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.prompt, { '1': { class_type: 'X', inputs: {} } });
  assert.equal(typeof body.client_id, 'string');
});

test('submit throws a descriptive error on non-2xx', async () => {
  const { fetchImpl } = fakeFetch([new Response('bad workflow', { status: 400 })]);
  const client = new ComfyClient('http://comfy:8188', { fetchImpl });
  await assert.rejects(client.submit({}), /\/prompt failed: 400.*bad workflow/);
});

test('submit throws a descriptive error on network failure', async () => {
  const { fetchImpl } = fakeFetch([new Error('ECONNREFUSED')]);
  const client = new ComfyClient('http://comfy:8188', { fetchImpl });
  await assert.rejects(client.submit({}), /ComfyUI unreachable.*ECONNREFUSED/);
});

test('host trailing slash is normalized', async () => {
  const { fetchImpl, calls } = fakeFetch([json({ prompt_id: 'x' })]);
  const client = new ComfyClient('http://comfy:8188/', { fetchImpl });
  await client.submit({});
  assert.equal(calls[0].url, 'http://comfy:8188/prompt');
  assert.equal(client.host, 'http://comfy:8188/');
});

test('waitForCompletion polls until success and returns outputs', async () => {
  const outputs = { '9': { images: [{ filename: 'a.png' }] } };
  const { fetchImpl, calls } = fakeFetch([
    json({}),
    json({ p1: { status: { status_str: 'running' } } }),
    json({ p1: { status: { status_str: 'success' }, outputs } }),
  ]);
  const sleeps: number[] = [];
  const client = new ComfyClient('http://c', { fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  const result = await client.waitForCompletion('p1', { intervalMs: 50 });
  assert.deepEqual(result, outputs);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://c/history/p1');
  assert.deepEqual(sleeps, [50, 50]);
});

test('waitForCompletion throws with execution_error message', async () => {
  const { fetchImpl } = fakeFetch([
    json({
      p1: {
        status: {
          status_str: 'error',
          messages: [
            ['execution_start', {}],
            ['execution_error', { exception_message: 'CUDA out of memory' }],
          ],
        },
      },
    }),
  ]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1'), /CUDA out of memory/);
});

test('waitForCompletion throws generic error when no exception message', async () => {
  const { fetchImpl } = fakeFetch([json({ p1: { status: { status_str: 'error', messages: [] } } })]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1'), /p1.*failed/);
});

test('waitForCompletion times out', async () => {
  const { fetchImpl } = fakeFetch([json({}), json({}), json({}), json({}), json({})]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1', { intervalMs: 10, timeoutMs: 25 }), /timed out/i);
});

test('waitForCompletion throws after repeated 5xx history responses', async () => {
  const { fetchImpl, calls } = fakeFetch([500, 500, 500, 500].map(() => new Response('boom', { status: 500 })));
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1'), /history.*500/);
  assert.equal(calls.length, 4);
});

test('waitForCompletion fails immediately on a 4xx history response', async () => {
  const { fetchImpl, calls } = fakeFetch([new Response('nope', { status: 404 })]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1'), /history.*404/);
  assert.equal(calls.length, 1);
});

test('waitForCompletion tolerates transient network and 5xx failures', async () => {
  const outputs = { '9': { images: [{ filename: 'a.png' }] } };
  const { fetchImpl, calls } = fakeFetch([
    new Error('ECONNRESET'),
    new Response('bad gateway', { status: 502 }),
    json({ p1: { status: { status_str: 'success' }, outputs } }),
  ]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  assert.deepEqual(await client.waitForCompletion('p1'), outputs);
  assert.equal(calls.length, 3);
});

test('waitForCompletion resets the failure counter after a successful poll', async () => {
  const outputs = {};
  const fail = () => new Error('ECONNRESET');
  const { fetchImpl } = fakeFetch([
    fail(),
    fail(),
    fail(),
    json({}),
    fail(),
    fail(),
    fail(),
    json({ p1: { status: { status_str: 'success' }, outputs } }),
  ]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  assert.deepEqual(await client.waitForCompletion('p1'), outputs);
});

test('waitForCompletion gives up after 3 consecutive failures and includes the last error', async () => {
  const { fetchImpl, calls } = fakeFetch([
    new Error('e1'),
    new Error('e2'),
    new Error('e3'),
    new Error('last-one'),
  ]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1'), /last-one/);
  assert.equal(calls.length, 4);
});

test('requests are aborted after the per-request timeout', async () => {
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep, requestTimeoutMs: 20 });
  // AbortSignal.timeout timers are unref'd; keep the loop alive so the abort can fire.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(client.submit({}), /unreachable.*aborted/);
  } finally {
    clearTimeout(keepAlive);
  }
});

function slowFetch(delayMs: number, body: BodyInit = '{}') {
  return ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(body)), delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    })) as typeof fetch;
}

test('download is not aborted at the short timeout but at its own transfer timeout', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const ok = new ComfyClient('http://c', { fetchImpl: slowFetch(80, 'video'), requestTimeoutMs: 20, transferTimeoutMs: 500 });
    assert.equal((await ok.download({ filename: 'a.mp4' })).toString(), 'video');
    const slow = new ComfyClient('http://c', { fetchImpl: slowFetch(500), requestTimeoutMs: 500, transferTimeoutMs: 20 });
    await assert.rejects(slow.download({ filename: 'a.mp4' }), /unreachable.*aborted/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('uploadImage uses the transfer timeout', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const ok = new ComfyClient('http://c', {
      fetchImpl: slowFetch(80, JSON.stringify({ name: 'u.png' })),
      requestTimeoutMs: 20,
      transferTimeoutMs: 500,
    });
    assert.equal(await ok.uploadImage(Buffer.from([1]), 'u.png'), 'u.png');
    const slow = new ComfyClient('http://c', { fetchImpl: slowFetch(500), requestTimeoutMs: 500, transferTimeoutMs: 20 });
    await assert.rejects(slow.uploadImage(Buffer.from([1]), 'u.png'), /unreachable.*aborted/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('submit, poll and interrupt still abort at the short timeout', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const mk = () => new ComfyClient('http://c', { fetchImpl: slowFetch(500), sleep: noSleep, requestTimeoutMs: 20, transferTimeoutMs: 500 });
    await assert.rejects(mk().submit({}), /unreachable.*aborted/);
    await assert.rejects(mk().interrupt(), /unreachable.*aborted/);
    await assert.rejects(mk().waitForCompletion('p', { timeoutMs: 1 }), /unreachable.*aborted|timed out/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('default transfer timeouts are longer than the short default', () => {
  const c = new ComfyClient('http://c') as unknown as { requestTimeoutMs: number; uploadTimeoutMs: number; downloadTimeoutMs: number };
  assert.equal(c.requestTimeoutMs, 30_000);
  assert.equal(c.uploadTimeoutMs, 120_000);
  assert.equal(c.downloadTimeoutMs, 600_000);
});

test('uploadImage posts multipart with image and overwrite, returns name', async () => {
  const { fetchImpl, calls } = fakeFetch([json({ name: 'up.png', subfolder: '', type: 'input' })]);
  const client = new ComfyClient('http://c', { fetchImpl });
  const name = await client.uploadImage(Buffer.from([1, 2, 3]), 'up.png');
  assert.equal(name, 'up.png');
  assert.equal(calls[0].url, 'http://c/upload/image');
  assert.equal(calls[0].init?.method, 'POST');
  const form = calls[0].init?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('overwrite'), 'true');
  const file = form.get('image') as File;
  assert.equal(file.name, 'up.png');
  assert.equal(file.size, 3);
});

test('uploadImage throws on non-2xx', async () => {
  const { fetchImpl } = fakeFetch([new Response('no', { status: 500 })]);
  const client = new ComfyClient('http://c', { fetchImpl });
  await assert.rejects(client.uploadImage(Buffer.from([1]), 'a.png'), /upload.*500/);
});

test('download builds /view URL with default type=output', async () => {
  const { fetchImpl, calls } = fakeFetch([new Response(new Uint8Array([7, 8]))]);
  const client = new ComfyClient('http://c', { fetchImpl });
  const buf = await client.download({ filename: 'v.mp4', subfolder: 'sub' });
  assert.deepEqual([...buf], [7, 8]);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/view');
  assert.equal(url.searchParams.get('filename'), 'v.mp4');
  assert.equal(url.searchParams.get('type'), 'output');
  assert.equal(url.searchParams.get('subfolder'), 'sub');
});

test('download honors explicit type and defaults subfolder to empty', async () => {
  const { fetchImpl, calls } = fakeFetch([new Response(new Uint8Array([1]))]);
  const client = new ComfyClient('http://c', { fetchImpl });
  await client.download({ filename: 'a.png', type: 'temp' });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('type'), 'temp');
  assert.equal(url.searchParams.get('subfolder'), '');
});

test('download throws on non-2xx', async () => {
  const { fetchImpl } = fakeFetch([new Response('', { status: 404 })]);
  const client = new ComfyClient('http://c', { fetchImpl });
  await assert.rejects(client.download({ filename: 'x' }), /view.*404/);
});

test('interrupt posts to /interrupt', async () => {
  const { fetchImpl, calls } = fakeFetch([new Response('')]);
  const client = new ComfyClient('http://c', { fetchImpl });
  await client.interrupt();
  assert.equal(calls[0].url, 'http://c/interrupt');
  assert.equal(calls[0].init?.method, 'POST');
});

test('extractOutputFile returns first image across nodes or null', () => {
  assert.deepEqual(
    extractOutputFile({ '1': { text: ['x'] }, '2': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }),
    { filename: 'a.png', subfolder: '', type: 'output' },
  );
  assert.equal(extractOutputFile({ '1': { images: [] } }), null);
  assert.equal(extractOutputFile({}), null);
});

test('extractVideoOutput finds images, gifs or videos', () => {
  assert.deepEqual(extractVideoOutput({ '1': { gifs: [{ filename: 'v.mp4', subfolder: 's', type: 'output' }] } }), {
    filename: 'v.mp4',
    subfolder: 's',
    type: 'output',
  });
  assert.equal(extractVideoOutput({ '1': { videos: [{ filename: 'w.mp4' }] } })?.filename, 'w.mp4');
  assert.equal(extractVideoOutput({ '1': { images: [{ filename: 'i.png' }] } })?.filename, 'i.png');
  assert.equal(extractVideoOutput({ '1': { gifs: [] } }), null);
});

test('downloadToFile streams the body to disk (full payload, not a truncated buffer)', async () => {
  // A sizable payload to make a truncation bug obvious if the stream were read partially.
  const payload = Buffer.alloc(200_000, 7);
  const { fetchImpl } = fakeFetch([new Response(payload, { status: 200 })]);
  const client = new ComfyClient('http://c', { fetchImpl });
  const dir = mkdtempSync(join(tmpdir(), 'vs-dl-'));
  const dest = join(dir, 'scene.mp4');
  const result = await client.downloadToFile({ filename: 'scene.mp4' }, dest);
  assert.equal(result, undefined, 'downloadToFile resolves to void, not a Buffer');
  assert.ok(readFileSync(dest).length >= payload.length, 'full payload landed on disk');
  assert.deepEqual(readFileSync(dest).subarray(0, 64), payload.subarray(0, 64), 'bytes are intact');
  rmSync(dir, { recursive: true, force: true });
});

test('downloadToFile surfaces an HTTP failure', async () => {
  const { fetchImpl } = fakeFetch([new Response('nope', { status: 404 })]);
  const client = new ComfyClient('http://c', { fetchImpl });
  await assert.rejects(client.downloadToFile({ filename: 'x' }, '/tmp/vs-dl-bad.bin'), /404/);
});
