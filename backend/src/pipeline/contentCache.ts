import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const STALE_TMP_MS = 3600_000;
const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

export interface CachePruneOptions {
  /** Remove entries whose mtime is older than this many ms. */
  maxAgeMs?: number;
  /** After the age rule, evict least-recently-used entries until the total is within this size. */
  maxBytes?: number;
  /** Clock injection for tests (epoch ms). */
  now?: number;
}

export interface CachePruneResult {
  removed: number;
  freedBytes: number;
  remainingBytes: number;
}

/**
 * Content-addressed artifact cache. Each produced item (a scene's TTS, still, or transition)
 * is stored under the sha256 of its content inputs. A retry — or a per-scene edit that leaves the
 * other scenes unchanged — re-produces only the items whose inputs actually changed, so the
 * expensive ComfyUI/Piper work is skipped.
 *
 * Kept deliberately simple (a flat directory of sha256-named files): deterministic and needs no
 * schema. Keys are portable across retries/edits of the SAME draft (the still/transition seed
 * derives from the draftId), not across different drafts. Writes are atomic (temp file + rename);
 * `prune` applies the TTL/size retention policy and uses mtime as the recency signal.
 */
export class ContentCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  get dirPath(): string {
    return this.dir;
  }

  /** Deterministic key for a family + ordered content fields. Bump `version` to invalidate a family. */
  key(version: string | number, ...fields: ReadonlyArray<string | number | boolean | undefined | null>): string {
    return sha256hex(JSON.stringify([version, ...fields]));
  }

  filePath(key: string): string {
    return join(this.dir, key);
  }

  has(key: string): boolean {
    return existsSync(this.filePath(key));
  }

  read(key: string): Buffer {
    return readFileSync(this.filePath(key));
  }

  private tmpPath(key: string): string {
    return join(this.dir, `${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  }

  /** Writes via `write(tmp)` then renames onto the final path; no partial file is ever visible. */
  private atomic(key: string, write: (tmp: string) => void): void {
    const tmp = this.tmpPath(key);
    try {
      write(tmp);
      renameSync(tmp, this.filePath(key));
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // the temp file may not exist; the original error is what matters
      }
      throw e;
    }
  }

  store(key: string, data: Buffer): void {
    this.atomic(key, (tmp) => writeFileSync(tmp, data));
  }

  /** Stores a file by copying it (never loads it into memory). */
  storeFile(key: string, srcPath: string): void {
    this.atomic(key, (tmp) => copyFileSync(srcPath, tmp));
  }

  /**
   * Copies an entry to `dest`. Returns false (a miss) when the entry vanished (e.g. pruned
   * between `has` and the copy); other errors are rethrown. A hit refreshes the entry's mtime.
   */
  copyTo(key: string, dest: string): boolean {
    const src = this.filePath(key);
    try {
      copyFileSync(src, dest);
    } catch (e) {
      if (isEnoent(e) && !existsSync(src)) return false;
      throw e;
    }
    try {
      const t = new Date();
      utimesSync(src, t, t);
    } catch {
      // recency is advisory; losing it must not fail a hit
    }
    return true;
  }

  /**
   * Best-effort retention: stale temp files, then entries past `maxAgeMs`, then LRU eviction
   * (oldest mtime first) until the total fits `maxBytes`. Never throws.
   */
  prune(opts: CachePruneOptions = {}): CachePruneResult {
    const now = opts.now ?? Date.now();
    let removed = 0;
    let freedBytes = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { removed, freedBytes, remainingBytes: 0 };
    }
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const drop = (path: string, size: number): boolean => {
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
      removed++;
      freedBytes += size;
      return true;
    };
    for (const name of names) {
      const path = join(this.dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (name.endsWith('.tmp')) {
        if (now - st.mtimeMs > STALE_TMP_MS) drop(path, st.size);
        continue; // a fresh .tmp is an in-flight write
      }
      if (opts.maxAgeMs !== undefined && now - st.mtimeMs > opts.maxAgeMs) {
        if (!drop(path, st.size)) entries.push({ path, size: st.size, mtimeMs: st.mtimeMs });
        continue;
      }
      entries.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    if (opts.maxBytes !== undefined && total > opts.maxBytes) {
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const e of entries) {
        if (total <= opts.maxBytes) break;
        if (drop(e.path, e.size)) total -= e.size;
      }
    }
    return { removed, freedBytes, remainingBytes: total };
  }
}

/** Absolute cache directory; the single place the `data/cache` default lives. */
export function resolveCacheDir(override?: string): string {
  return resolve(override ?? 'data/cache');
}

export interface CacheConfig {
  maxAgeMs: number;
  maxBytes: number;
}

/** `CACHE_TTL_DAYS` (default 30) and `CACHE_MAX_GB` (default 20); empty/invalid/<=0 -> default. */
export function cacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const pos = (v: string | undefined, def: number): number => {
    const s = v?.trim();
    if (!s) return def;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    maxAgeMs: pos(env.CACHE_TTL_DAYS, 30) * 24 * 3600_000,
    maxBytes: pos(env.CACHE_MAX_GB, 20) * 1024 ** 3,
  };
}

export interface CachePruningDeps {
  dir: string;
  config: CacheConfig;
  log: { info(msg: string): void; warn(msg: string, meta?: Record<string, unknown>): void };
  intervalMs?: number;
  now?: () => number;
}

/** Prunes once now and then every `intervalMs` on an unref'd timer, so it never keeps the process alive. */
export function startCachePruning(deps: CachePruningDeps): { stop(): void } {
  const { dir, config, log, intervalMs = 6 * 3600_000, now } = deps;
  const run = (): void => {
    try {
      const r = new ContentCache(dir).prune({ ...config, now: now?.() });
      if (r.removed > 0) {
        log.info(`cache prune removed ${r.removed} file(s), freed ${r.freedBytes} bytes, ${r.remainingBytes} bytes remain`);
      }
    } catch (err) {
      log.warn('cache prune failed', { err });
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * Bump to invalidate the ComfyUI-render family (stills + transitions) when the workflow or
 * sampling changes. Now at 2 for the Wan 2.2 dual-expert chain (invalidates any one-expert renders).
 */
export const WORKFLOW_VERSION = 2;

/** Bump to invalidate the Piper TTS family when the engine or voices change. */
export const TTS_CACHE_VERSION = 1;
