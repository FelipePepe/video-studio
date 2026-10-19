import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export interface FetchArticleOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export class ArticleInputError extends Error {}
export class ArticleFetchError extends Error {}

const MAX_TEXT_CHARS = 12_000;

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

// Minimal article score: Readability rejects tiny/boilerplate pages (nav, footers, cookies);
// below this text length we fall back to the naive tag-strip so short pages and test fixtures
// still work.
const READABILITY_MIN_CHARS = 200;

function legacyStrip(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  // &amp; last so "&amp;lt;" decodes to "&lt;" and not "<".
  for (const [pattern, value] of ENTITIES) text = text.replace(pattern, value);
  return text.replace(/\s+/g, ' ').trim();
}

export function htmlToText(html: string): string {
  // Prefer Readability + linkedom: it drops navigation/footer/cookie/"related" chrome and
  // linkedom's textContent decodes ALL named+numeric HTML entities (accents, ñ, curly quotes) —
  // not just the 6 the legacy strip handled.
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    const text = (article?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= READABILITY_MIN_CHARS) return text;
  } catch {
    // non-article / parser edge case: fall through to the legacy strip.
  }
  return legacyStrip(html);
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArticleInputError('url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArticleInputError('url must use http or https');
  }
  if (url.username || url.password) throw new ArticleInputError('url must not contain credentials');
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new ArticleFetchError(`Article is too large (limit ${maxBytes} bytes)`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Private-network hosts are intentionally allowed (personal intranet tool), so there is no SSRF
// host filtering; the scheme, credential, size and time limits below still apply.
export async function fetchArticleText(rawUrl: string, opts: FetchArticleOptions = {}): Promise<string> {
  const { fetchImpl = fetch, timeoutMs = 15_000, maxBytes = 2_000_000 } = opts;
  const url = parseUrl(rawUrl);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url.href, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new ArticleFetchError(`Article fetch failed: HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/^text\/html\b/i.test(type)) {
      throw new ArticleFetchError(`Unsupported content type "${type || 'unknown'}", expected text/html`);
    }
    return htmlToText(await readCapped(res, maxBytes)).slice(0, MAX_TEXT_CHARS);
  } catch (e) {
    if (e instanceof ArticleFetchError) throw e;
    if (timedOut) throw new ArticleFetchError(`Article fetch timed out after ${timeoutMs}ms`);
    throw new ArticleFetchError(`Article fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
