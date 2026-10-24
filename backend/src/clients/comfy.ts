import { randomUUID } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';

export interface ComfyFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

export type ComfyOutputs = Record<string, unknown>;

export interface ProgressInfo {
  /** ComfyUI node id currently executing. */
  node?: string;
  /** Sampler step progress (0..max), when the server reports it. */
  value?: number;
  max?: number;
  /** Terminal tick (execution finished for this prompt). */
  done?: boolean;
}

/**
 * Minimal WebSocket surface the client needs (compatible with the global undici `WebSocket` and with
 * test fakes). Only 'message'/'close'/'error' are listened to.
 */
export interface WebSocketLike {
  close(): void;
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
}

export interface ComfyClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Timeout for short calls (submit, poll, interrupt). Default 30 s. */
  requestTimeoutMs?: number;
  /** Timeout for uploadImage and download. Defaults: 120 s upload, 600 s download. */
  transferTimeoutMs?: number;
  /** How to open the progress WebSocket. May throw → client falls back to polling-only. */
  wsFactory?: (url: string) => WebSocketLike;
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /**
   * When provided, ComfyUI's per-step progress is streamed over the WebSocket to this callback
   * (executing:{node,progress:{value,max}} / progress / execution_success|error). Completion and
   * output extraction still use the robust /history polling — the socket only adds live progress.
   */
  onProgress?: (info: ProgressInfo) => void;
  /**
   * B3: abort the wait early (job cancellation). Throws an Error named 'AbortError' on the next
   * loop iteration without issuing further polls.
   */
  signal?: AbortSignal;
  /**
   * B3: after this many consecutive empty /history responses (default 30), the client checks
   * /queue — if the prompt is in neither history nor queue it fails fast (e.g. ComfyUI restarted
   * and the prompt was lost) instead of polling until the global timeout.
   */
  emptyHistoryLimit?: number;
}

interface HistoryEntry {
  outputs?: ComfyOutputs;
  status?: { status_str?: string; messages?: Array<[string, unknown]> };
}

const MAX_POLL_FAILURES = 3;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Opens a live WebSocket using the runtime global (undici). Throws if unavailable (client falls back to polling-only). */
function defaultWsFactory(url: string): WebSocketLike {
  const W = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof W !== 'function') throw new Error('WebSocket is not available in this runtime');
  return new W(url);
}

function firstFile(node: unknown, keys: string[]): ComfyFile | null {
  const n = node as Record<string, ComfyFile[] | undefined> | null;
  for (const key of keys) {
    const file = n?.[key]?.[0];
    if (file?.filename) return file;
  }
  return null;
}

export function extractOutputFile(outputs: ComfyOutputs): ComfyFile | null {
  for (const node of Object.values(outputs)) {
    const file = firstFile(node, ['images']);
    if (file) return file;
  }
  return null;
}

export function extractVideoOutput(outputs: ComfyOutputs): ComfyFile | null {
  for (const node of Object.values(outputs)) {
    const file = firstFile(node, ['gifs', 'videos', 'images']);
    if (file) return file;
  }
  return null;
}

function executionError(entry: HistoryEntry): string | undefined {
  for (const [kind, data] of entry.status?.messages ?? []) {
    if (kind === 'execution_error') {
      return (data as { exception_message?: string } | undefined)?.exception_message;
    }
  }
  return undefined;
}

class TransientPollError extends Error {}

export class ComfyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly wsFactory: (url: string) => WebSocketLike;
  /** Stable client identity shared by the /prompt POST (client_id) and the progress WebSocket. */
  readonly clientId = randomUUID();

  constructor(
    readonly host: string,
    opts: ComfyClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.uploadTimeoutMs = opts.transferTimeoutMs ?? 120_000;
    this.downloadTimeoutMs = opts.transferTimeoutMs ?? 600_000;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
  }

  private url(path: string): string {
    return `${this.host.replace(/\/+$/, '')}${path}`;
  }

  private async request(path: string, init?: RequestInit, timeoutMs: number = this.requestTimeoutMs): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), { signal: AbortSignal.timeout(timeoutMs), ...init });
    } catch (e) {
      throw new Error(`ComfyUI unreachable at ${this.host}: ${(e as Error).message}`);
    }
  }

  private async fail(what: string, res: Response): Promise<never> {
    const body = await res.text().catch(() => '');
    throw new Error(`ComfyUI ${what} failed: ${res.status}${body ? ` ${body}` : ''}`);
  }

  async submit(workflow: object): Promise<string> {
    const res = await this.request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!res.ok) return this.fail('/prompt', res);
    const data = (await res.json()) as { prompt_id?: string };
    if (!data.prompt_id) throw new Error('ComfyUI /prompt response has no prompt_id');
    return data.prompt_id;
  }

  private async pollHistory(promptId: string): Promise<HistoryEntry | undefined> {
    let res: Response;
    try {
      res = await this.request(`/history/${encodeURIComponent(promptId)}`);
    } catch (e) {
      throw new TransientPollError((e as Error).message);
    }
    if (res.status >= 500) {
      const body = await res.text().catch(() => '');
      throw new TransientPollError(`ComfyUI /history/${promptId} failed: ${res.status}${body ? ` ${body}` : ''}`);
    }
    if (!res.ok) return this.fail(`/history/${promptId}`, res);
    const history = (await res.json()) as Record<string, HistoryEntry | undefined>;
    return history[promptId];
  }

  /** ComfyUI's WebSocket endpoint (ws(s)://host/ws?clientId=\<id\>). */
  private wsUrl(): string {
    const u = new URL(this.host);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.searchParams.set('clientId', this.clientId);
    return u.toString();
  }

  /**
   * Opens the ComfyUI progress WebSocket (if available) and streams per-step progress for `promptId`
   * to `onProgress`. Returns a disposer (closes the socket) or `null` when no socket could be opened
   * (the client then relies on /history polling alone). Never throws.
   */
  private openProgressSocket(promptId: string, onProgress: (info: ProgressInfo) => void): (() => void) | null {
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.wsUrl());
    } catch {
      return null;
    }
    const close = (): void => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const handleMessage = (ev: { data?: unknown }): void => {
      let msg: { type?: string; data?: Record<string, unknown> };
      try {
        const raw = ev.data;
        msg = typeof raw === 'string' ? (JSON.parse(raw) as typeof msg) : (raw as typeof msg);
      } catch {
        return;
      }
      const data = msg.data ?? {};
      if (msg.type === 'executing') {
        if (data.prompt_id !== promptId) return;
        if (data.node == null) {
          onProgress({ done: true });
          close();
          return;
        }
        const pr = (data.progress ?? {}) as { value?: number; max?: number };
        onProgress({ node: String(data.node), value: pr.value ?? 0, max: pr.max ?? 0 });
      } else if (msg.type === 'progress') {
        if (data.prompt_id !== promptId) return;
        onProgress({ value: (data.value as number) ?? 0, max: (data.max as number) ?? 0 });
      } else if ((msg.type === 'execution_success' || msg.type === 'execution_error') && data.prompt_id === promptId) {
        onProgress({ done: true });
        close();
      }
    };
    try {
      ws.addEventListener('message', handleMessage);
      ws.addEventListener('close', () => {});
      ws.addEventListener('error', () => {});
    } catch {
      return null;
    }
    return close;
  }

  async waitForCompletion(promptId: string, opts: WaitOptions = {}): Promise<ComfyOutputs> {
    const { intervalMs = 2000, timeoutMs = 3_600_000, emptyHistoryLimit = 30 } = opts;
    let elapsed = 0;
    let failures = 0;
    let emptyStreak = 0;
    const started = Date.now();
    const progress = opts.onProgress ? this.openProgressSocket(promptId, opts.onProgress) : null;
    try {
      for (;;) {
        // B3: check cancellation first — abort must not issue further polls.
        if (opts.signal?.aborted) {
          const e = new Error(`ComfyUI prompt ${promptId} wait aborted`);
          e.name = 'AbortError';
          throw e;
        }
        // B3: timeout is measured in real elapsed time, not in summed intervalMs — the /history
        // calls themselves take wall time a busy server/event loop can stretch well past timeoutMs.
        if (Date.now() - started > timeoutMs) {
          throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
        }
        if (elapsed + intervalMs > timeoutMs) {
          throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
        }
        let entry: HistoryEntry | undefined;
        try {
          entry = await this.pollHistory(promptId);
          failures = 0;
        } catch (e) {
          if (!(e instanceof TransientPollError) || ++failures > MAX_POLL_FAILURES) throw e;
        }
        emptyStreak = entry ? 0 : emptyStreak + 1;
        const status = entry?.status?.status_str;
        if (entry && status === 'error') {
          const detail = executionError(entry);
          throw new Error(`ComfyUI prompt ${promptId} failed${detail ? `: ${detail}` : ''}`);
        }
        if (entry && status === 'success') return entry.outputs ?? {};
        // B3: an empty /history is normal while the prompt waits in the queue — but if ComfyUI
        // restarted (or the prompt was removed) the entry is gone for good: detect it fast.
        if (!entry && emptyStreak >= emptyHistoryLimit) {
          let confirmedGone = false;
          try {
            const { running, pending } = await this.queueIds();
            if (running.includes(promptId) || pending.includes(promptId)) {
              emptyStreak = 0; // still waiting in ComfyUI's queue — keep polling
            } else {
              confirmedGone = true;
            }
          } catch {
            /* queue check failed (transient) — keep polling */
          }
          if (confirmedGone) {
            throw new Error(
              `ComfyUI prompt ${promptId}: no history entry and not in the queue (lost — server restart?); aborting wait after ${emptyHistoryLimit} empty polls`,
            );
          }
        }
        await this.sleep(intervalMs);
        elapsed += intervalMs;
      }
    } finally {
      progress?.();
    }
  }

  async uploadImage(data: Buffer | Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), filename);
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form }, this.uploadTimeoutMs);
    if (!res.ok) return this.fail('/upload/image', res);
    const body = (await res.json()) as { name?: string };
    if (!body.name) throw new Error('ComfyUI /upload/image response has no name');
    return body.name;
  }

  async download(file: ComfyFile): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: file.filename,
      type: file.type ?? 'output',
      subfolder: file.subfolder ?? '',
    });
    const res = await this.request(`/view?${params}`, undefined, this.downloadTimeoutMs);
    if (!res.ok) return this.fail('/view', res);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Stream the file at `file` straight to `dest` by reading the HTTP body in chunks and writing
   * them to the write stream. Avoids the `arrayBuffer()` path which retains the whole MP4 (or any
   * large asset) in RAM, and avoids a blocking `writeFileSync`, both of which stall the event loop
   * and the SSE progress stream while the payload is written. Caller is responsible for ensuring
   * the parent directory exists.
   */
  async downloadToFile(file: ComfyFile, dest: string): Promise<void> {
    const params = new URLSearchParams({
      filename: file.filename,
      type: file.type ?? 'output',
      subfolder: file.subfolder ?? '',
    });
    const res = await this.request(`/view?${params}`, undefined, this.downloadTimeoutMs);
    if (!res.ok) return this.fail('/view', res);
    if (!res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`ComfyUI /view failed: no body${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
    const writer = createWriteStream(dest);
    const reader = res.body.getReader();
    // B1: the writer's 'error' listener is attached BEFORE any data moves. The old code attached
    // it only after the read loop finished, so a mid-stream failure (network drop, disk full) or
    // a body error fired while no error handler existed → unhandled 'error' event → uncaughtException
    // → the whole backend process died because of one bad download.
    const settled = new Promise<void>((resolve, reject) => {
      writer.once('finish', resolve);
      writer.once('error', (e) => reject(e));
    });
    // Guard: if the writer error surfaces after the download promise has already failed, the
    // rejection must not become an unhandledRejection (e.g. a lazily-opened fd failing later).
    settled.catch(() => {});
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !writer.write(value)) {
          // Race backpressure against a writer error so a failing writer cannot deadlock the loop.
          await Promise.race([new Promise<void>((resolve) => writer.once('drain', resolve)), settled]);
        }
      }
      writer.end();
      await settled;
    } catch (err) {
      writer.destroy();
      rmSync(dest, { force: true }); // never leave a partial asset behind
      throw new Error(`ComfyUI /view download to ${dest} failed: ${(err as Error).message}`);
    }
  }

  /**
   * List prompt ids currently in ComfyUI's queue (running first, then pending). Used to decide
   * whether a "missing history" case is a prompt still waiting or one that was lost (server
   * restart), and to target cancellation at the job's own prompt instead of a global interrupt.
   */
  async queueIds(): Promise<{ running: string[]; pending: string[] }> {
    const res = await this.request('/queue');
    if (!res.ok) return this.fail('/queue', res);
    const data = (await res.json()) as {
      queue_running?: Array<unknown>;
      queue_pending?: Array<unknown>;
    };
    // Real ComfyUI /queue entries are [position, prompt_id, prompt, client_id].
    // position (index 0) is a number; the prompt_id is the FIRST string in the entry.
    // Selecting "first string" is robust to the position/client_id layout rather than
    // assuming a fixed index (old code read index 0 = position, so it always returned []
    // and a healthy running prompt was wrongly treated as "lost / server restart").
    const promptIdOf = (entry: unknown): string | undefined => {
      if (!Array.isArray(entry)) return undefined;
      for (const value of entry) {
        if (typeof value === 'string') return value;
      }
      return undefined;
    };
    const ids = (arr: Array<unknown> | undefined): string[] =>
      (arr ?? []).map((e) => promptIdOf(e)).filter((x): x is string => typeof x === 'string');
    return { running: ids(data.queue_running), pending: ids(data.queue_pending) };
  }

  /**
   * Interrupt ComfyUI execution. B2: pass the job's own prompt id to target it (body
   * `{"prompt_id": ...}` — forward-compatible; ComfyUI 0.28 core ignores the body and interrupts
   * the current run globally, so the orchestrator only calls this when the job's prompt is the
   * one running). Omit the id for a plain global interrupt.
   */
  async interrupt(promptId?: string): Promise<void> {
    const init: RequestInit = { method: 'POST' };
    if (promptId) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ prompt_id: promptId });
    }
    const res = await this.request('/interrupt', init);
    if (!res.ok) await this.fail('/interrupt', res);
  }

  /**
   * Remove a prompt from ComfyUI's queue (owner-scoped cancellation fallback). ComfyUI 0.28 core
   * returns 405 here — callers must treat failure as a benign no-op; newer cores may support it.
   */
  async deletePrompt(promptId: string): Promise<void> {
    const res = await this.request(`/prompt/${encodeURIComponent(promptId)}`, { method: 'DELETE' });
    if (!res.ok) await this.fail(`/prompt/${promptId}`, res);
  }
}
