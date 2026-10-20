import type {
  ApproveBody,
  Draft,
  DraftCreated,
  DraftRequest,  Escaleta,
  Job,
  JobEvent,
  JobStatus,
  MusicLibrary,
  Settings,
  VoiceOption,
} from './types';
import { log } from '../lib/logger';

export type { ApproveBody };

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApproveOptions {
  onEvent: (event: JobEvent) => void;
  /** Aborting only stops listening; the backend job keeps running. */
  signal?: AbortSignal;
  /** Render options (music, volume, subtitles, vertical). Omitted = backend defaults. */
  body?: ApproveBody;
}

export interface ApiClient {
  getConfig(): Promise<Settings>;
  patchConfig(partial: Partial<Settings>): Promise<Settings>;
  /** Ollama model names; returns [] on any failure so the UI falls back to free text. */
  listModels(): Promise<string[]>;
  createDraft(req: DraftRequest): Promise<DraftCreated>;
  getDraft(id: string): Promise<Draft>;
  putSegments(id: string, escaleta: Escaleta): Promise<Draft>;
  approveDraft(id: string, options: ApproveOptions): Promise<JobEvent | undefined>;
  /** Returns null when the music library is not configured (404). */
  listMusic(): Promise<MusicLibrary | null>;
  /** Piper roster; returns [] on failure so the UI can fall back to male/female. */
  listVoices(): Promise<VoiceOption[]>;
  getJob(id: string): Promise<Job>;
  /** Job list; optional status filter and limit (backend caps limit at 200). */
  listJobs(params?: { status?: JobStatus; limit?: number }): Promise<Job[]>;
  cancelJob(id: string): Promise<{ cancelled: boolean }>;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Reads a `text/event-stream` body and calls `onData` with each parsed `data:` payload.
 * Comments (`: ping`) and frames whose JSON is malformed are skipped. Frames may be split
 * across chunks. Resolves when the stream ends.
 */
export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onData: (data: unknown) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (frame: string) => {
    const payload = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    onData(parsed);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        dispatch(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`;
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === 'string' && error) message = error;
  } catch {
    // Non-JSON error body: keep the generic status message.
  }
  return new ApiError(res.status, message);
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const apiLog = log.child('api');
  // Resolved lazily so a late-installed global fetch (or a test fake) is honoured.
  const doFetch: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await doFetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      const error = await toApiError(res);
      apiLog.warn('request failed', { method, path, status: res.status, message: error.message });
      throw error;
    }
    return (await res.json()) as T;
  }

  const draftPath = (id: string) => `/api/pipeline/draft/${encodeURIComponent(id)}`;
  const jobPath = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;

  return {
    getConfig: () => request<Settings>('GET', '/api/config'),
    patchConfig: (partial) => request<Settings>('PATCH', '/api/config', partial),
    async listModels() {
      try {
        const body = await request<{ models: string[] }>('GET', '/api/ollama/models');
        return Array.isArray(body.models) ? body.models : [];
      } catch {
        return [];
      }
    },
    createDraft: (req) => request<DraftCreated>('POST', '/api/pipeline/draft', req),
    getDraft: (id) => request<Draft>('GET', draftPath(id)),
    putSegments: (id, escaleta) => request<Draft>('PUT', `${draftPath(id)}/segments`, { escaleta }),
    getJob: (id) => request<Job>('GET', jobPath(id)),
    listJobs(params) {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.limit !== undefined) qs.set('limit', String(params.limit));
      const q = qs.toString();
      return request<Job[]>('GET', `/api/jobs${q ? `?${q}` : ''}`);
    },
    cancelJob: (id) => request<{ cancelled: boolean }>('POST', `${jobPath(id)}/cancel`),

    async listMusic() {
      try {
        return await request<MusicLibrary>('GET', '/api/music');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    async listVoices() {
      try {
        return await request<VoiceOption[]>('GET', '/api/pipeline/voices');
      } catch {
        return [];
      }
    },

    async approveDraft(id, { onEvent, signal, body }) {
      let last: JobEvent | undefined;
      try {
        const init: RequestInit = {
          method: 'POST',
          headers: { Accept: 'text/event-stream' },
          signal,
        };
        if (body !== undefined) {
          init.headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        const res = await doFetch(`${baseUrl}${draftPath(id)}/approve`, init);
        if (!res.ok) throw await toApiError(res);
        if (!res.body) return undefined;
        await parseSseStream(res.body, (data) => {
          last = data as JobEvent;
          onEvent(last);
        });
      } catch (e) {
        // Aborting only stops listening: resolve with whatever was seen so far.
        if (signal?.aborted && !(e instanceof ApiError)) return last;
        throw e;
      }
      return last;
    },
  };
}
