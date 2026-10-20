import { randomUUID } from 'node:crypto';

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
    const { intervalMs = 2000, timeoutMs = 3_600_000 } = opts;
    let elapsed = 0;
    let failures = 0;
    const progress = opts.onProgress ? this.openProgressSocket(promptId, opts.onProgress) : null;
    try {
      for (;;) {
        let entry: HistoryEntry | undefined;
        try {
          entry = await this.pollHistory(promptId);
          failures = 0;
        } catch (e) {
          if (!(e instanceof TransientPollError) || ++failures > MAX_POLL_FAILURES) throw e;
        }
        const status = entry?.status?.status_str;
        if (entry && status === 'error') {
          const detail = executionError(entry);
          throw new Error(`ComfyUI prompt ${promptId} failed${detail ? `: ${detail}` : ''}`);
        }
        if (entry && status === 'success') return entry.outputs ?? {};
        if (elapsed + intervalMs > timeoutMs) {
          throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
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

  async interrupt(): Promise<void> {
    const res = await this.request('/interrupt', { method: 'POST' });
    if (!res.ok) await this.fail('/interrupt', res);
  }
}
