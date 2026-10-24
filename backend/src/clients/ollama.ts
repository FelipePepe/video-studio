export interface OllamaClientOptions {
  fetchImpl?: typeof fetch;
  model?: string;
  /** Context window sent as `options.num_ctx`; falls back to env OLLAMA_NUM_CTX, else the server default. */
  numCtx?: number;
  /** Ollama `keep_alive` duration. Default `"0s"` = release the model right after the call (frees VRAM/RAM for ComfyUI). Override via option or env OLLAMA_KEEP_ALIVE. */
  keepAlive?: string;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  return value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

export interface ChatJsonOptions {
  system: string;
  user: string;
  model?: string;
  signal?: AbortSignal;
}

export class OllamaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly model?: string;
  private readonly numCtx?: number;
  private readonly keepAlive?: string;

  constructor(
    readonly host: string,
    opts: OllamaClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.model = opts.model;
    this.numCtx = opts.numCtx;
    this.keepAlive = opts.keepAlive;
  }

  /** Lists the model names (Ollama `/api/tags`), skipping entries without a name. */
  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host.replace(/\/+$/, '')}/api/tags`, { method: 'GET' });
    } catch (e) {
      throw new Error(`Ollama unreachable at ${this.host}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama /api/tags failed: ${res.status}${body ? ` ${body}` : ''}`);
    }
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    if (!Array.isArray(data.models)) return [];
    return data.models
      .map((m) => (typeof m?.name === 'string' ? m.name : null))
      .filter((n): n is string => n !== null);
  }

  async chatJson<T = unknown>(opts: ChatJsonOptions): Promise<T> {
    const model = opts.model ?? this.model ?? process.env.OLLAMA_MODEL ?? 'gemma4:26b';
    const numCtx = this.numCtx ?? parsePositiveInt(process.env.OLLAMA_NUM_CTX);
    // Default to "0s" so the model is released as soon as the escaleta is done, freeing
    // VRAM/RAM on the (memory-constrained) host for ComfyUI. Override: option, then OLLAMA_KEEP_ALIVE.
    const keepAlive = this.keepAlive ?? (process.env.OLLAMA_KEEP_ALIVE?.trim() || '0s');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          keep_alive: keepAlive,
          ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
        }),
      });
    } catch (e) {
      throw new Error(`Ollama unreachable at ${this.host}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat failed: ${res.status}${body ? ` ${body}` : ''}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (typeof content !== 'string') throw new Error('Ollama response has no message content');
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new Error(`Ollama content is not valid JSON: ${content.slice(0, 200)}`);
    }
  }
}
