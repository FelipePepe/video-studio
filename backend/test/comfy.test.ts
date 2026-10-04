import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('waitForCompletion throws on non-2xx history response', async () => {
  const { fetchImpl } = fakeFetch([new Response('boom', { status: 500 })]);
  const client = new ComfyClient('http://c', { fetchImpl, sleep: noSleep });
  await assert.rejects(client.waitForCompletion('p1'), /history.*500/);
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
