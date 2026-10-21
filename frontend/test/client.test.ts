import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../src/api/client';
import type { Job, JobEvent } from '../src/api/types';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('listMusic', () => {
  it('GETs /api/music and returns the library', async () => {
    const lib = { musicDir: '/music', files: [{ name: 'a.mp3', path: '/music/a.mp3', size: 1, mtime: 'x' }] };
    const { fetchImpl, calls } = fakeFetch(() => json(lib));
    expect(await createApiClient({ fetchImpl }).listMusic()).toEqual(lib);
    expect(calls[0].url).toBe('/api/music');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('returns null (not an error) when the library is not configured (404)', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'Music library not configured (set MUSIC_DIR)' }, 404));
    expect(await createApiClient({ fetchImpl }).listMusic()).toBeNull();
  });
});

describe('listVoices', () => {
  it('GETs /api/pipeline/voices', async () => {
    const roster = [{ name: 'es_ES-davefx-medium' }, { name: 'es_ES-sharvard-medium', speaker: 1 }];
    const { fetchImpl, calls } = fakeFetch(() => json(roster));
    expect(await createApiClient({ fetchImpl }).listVoices()).toEqual(roster);
    expect(calls[0].url).toBe('/api/pipeline/voices');
  });

  it('returns [] on failure so the UI can fall back to male/female', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('boom', { status: 502 }));
    expect(await createApiClient({ fetchImpl }).listVoices()).toEqual([]);
  });
});

describe('listJobs', () => {
  const job = (id: string, status: Job['status']): Job => ({
    id,
    draftId: 'd1',
    status,
    stage: '',
    progress: 0,
    error: null,
    outputPath: null,
    options: null,
    createdAt: '2026-10-17T10:00:00Z',
    updatedAt: '2026-10-17T10:00:00Z',
    startedAt: null,
    finishedAt: null,
  });

  it('GETs /api/jobs and returns the list', async () => {
    const jobs = [job('j2', 'done'), job('j1', 'running')];
    const { fetchImpl, calls } = fakeFetch(() => json(jobs));
    expect(await createApiClient({ fetchImpl }).listJobs()).toEqual(jobs);
    expect(calls[0].url).toBe('/api/jobs');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('sends status and limit as query params only when provided', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json([]));
    const api = createApiClient({ fetchImpl });
    await api.listJobs({ status: 'running', limit: 50 });
    expect(calls[0].url).toBe('/api/jobs?status=running&limit=50');
    await api.listJobs();
    expect(calls[1].url).toBe('/api/jobs');
  });
});

describe('approveDraft body', () => {
  const emptySse = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  it('sends the approve options body when provided', async () => {
    const { fetchImpl, calls } = fakeFetch(() => emptySse());
    const body = { music: '/music/a.mp3', musicVolume: 0.3, subtitles: true, vertical: false };
    await createApiClient({ fetchImpl }).approveDraft('d1', { onEvent: () => {}, body });
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual(body);
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('sends no body or content-type when options are omitted', async () => {
    const { fetchImpl, calls } = fakeFetch(() => emptySse());
    await createApiClient({ fetchImpl }).approveDraft('d1', { onEvent: () => {} });
    expect(calls[0].init?.body).toBeUndefined();
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBeNull();
  });
});

const settings = { comfyHost: 'http://c', ollamaHost: 'http://o', piperHost: 'tcp://p:1' };

describe('api client requests', () => {
  it('getConfig GETs /api/config', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(settings));
    expect(await createApiClient({ fetchImpl }).getConfig()).toEqual(settings);
    expect(calls[0].url).toBe('/api/config');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
  });

  it('patchConfig PATCHes only the given fields as JSON', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(settings));
    await createApiClient({ fetchImpl }).patchConfig({ ollamaHost: 'http://x' });
    expect(calls[0].url).toBe('/api/config');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ ollamaHost: 'http://x' });
  });

  it('createDraft POSTs the request and returns the draft', async () => {
    const created = { id: 'd1', escaleta: [], status: 'draft' };
    const { fetchImpl, calls } = fakeFetch(() => json(created, 201));
    expect(await createApiClient({ fetchImpl }).createDraft({ text: 'hi' })).toEqual(created);
    expect(calls[0].url).toBe('/api/pipeline/draft');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ text: 'hi' });
  });

  it('getDraft GETs the encoded id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ id: 'a/b' }));
    await createApiClient({ fetchImpl }).getDraft('a/b');
    expect(calls[0].url).toBe('/api/pipeline/draft/a%2Fb');
  });

  it('putSegments PUTs { escaleta }', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ id: 'd1' }));
    const escaleta = [{ scene: 1, title: 't', narration: 'n', visualPrompt: 'v', voice: 'male' }];
    await createApiClient({ fetchImpl }).putSegments('d1', escaleta);
    expect(calls[0].url).toBe('/api/pipeline/draft/d1/segments');
    expect(calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ escaleta });
  });

  it('getJob GETs and cancelJob POSTs', async () => {
    const { fetchImpl, calls } = fakeFetch((c) => (c.url.endsWith('cancel') ? json({ cancelled: true }) : json({ id: 'j1' })));
    const api = createApiClient({ fetchImpl });
    await api.getJob('j1');
    expect(await api.cancelJob('j1')).toEqual({ cancelled: true });
    expect(calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([
      ['/api/jobs/j1', 'GET'],
      ['/api/jobs/j1/cancel', 'POST'],
    ]);
  });

  it('maps backend { error } responses to ApiError', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'comfyHost must be an http or https URL' }, 400));
    const err = await createApiClient({ fetchImpl }).patchConfig({ comfyHost: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('comfyHost must be an http or https URL');
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>boom</html>', { status: 502 }));
    const err = await createApiClient({ fetchImpl }).getConfig().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
  });
});

describe('approveDraft', () => {
  const sse = (chunks: string[], status = 200) => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(enc.encode(x));
          c.close();
        },
      }),
      { status, headers: { 'Content-Type': 'text/event-stream' } },
    );
  };

  it('POSTs to the approve endpoint and delivers events in order, returning the last', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      sse([
        'data: {"type":"stage","jobId":"j","stage":"queued"}\n\n: ping\n\n',
        'data: {"type":"progress","jobId":"j","progress":0.5}\n\ndata: {"type":"do',
        'ne","jobId":"j","outputUrl":"/api/jobs/j/output"}\n\n',
      ]),
    );
    const seen: JobEvent[] = [];
    const last = await createApiClient({ fetchImpl }).approveDraft('d1', { onEvent: (e) => seen.push(e) });
    expect(calls[0].url).toBe('/api/pipeline/draft/d1/approve');
    expect(calls[0].init?.method).toBe('POST');
    expect(seen.map((e) => e.type)).toEqual(['stage', 'progress', 'done']);
    expect(last).toEqual(seen[2]);
  });

  it('returns undefined when the stream carries no events', async () => {
    const { fetchImpl } = fakeFetch(() => sse([': ping\n\n']));
    expect(await createApiClient({ fetchImpl }).approveDraft('d1', { onEvent: () => {} })).toBeUndefined();
  });

  it('rejects with ApiError on HTTP errors and never calls onEvent', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'Draft is already approved' }, 409));
    const events: JobEvent[] = [];
    const err = await createApiClient({ fetchImpl })
      .approveDraft('d1', { onEvent: (e) => events.push(e) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Draft is already approved');
    expect(events).toEqual([]);
  });

  it('stops listening when aborted without cancelling the job', async () => {
    const controller = new AbortController();
    let cancelCalled = false;
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/cancel')) cancelCalled = true;
      const enc = new TextEncoder();
      const signal = c.init?.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(enc.encode('data: {"type":"stage","jobId":"j"}\n\n'));
            signal.addEventListener('abort', () => ctrl.error(new DOMException('Aborted', 'AbortError')));
          },
        }),
      );
    });
    const seen: JobEvent[] = [];
    const promise = createApiClient({ fetchImpl }).approveDraft('d1', {
      onEvent: (e) => {
        seen.push(e);
        controller.abort();
      },
      signal: controller.signal,
    });
    const last = await promise;
    expect(seen).toHaveLength(1);
    expect(last).toEqual(seen[0]);
    expect(cancelCalled).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
