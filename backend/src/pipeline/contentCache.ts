import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Content-addressed artifact cache. Each produced item (a scene's TTS, still, or transition)
 * is stored under the sha256 of its content inputs. A retry — or a per-scene edit that leaves the
 * other scenes unchanged — re-produces only the items whose inputs actually changed, so the
 * expensive ComfyUI/Piper work is skipped.
 *
 * Kept deliberately simple (a flat directory of sha256-named files): deterministic, portable
 * across jobs, and needs no schema. A retention policy is a separate maintenance improvement.
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

  store(key: string, data: Buffer): void {
    writeFileSync(this.filePath(key), data);
  }
}

/**
 * Bump to invalidate the ComfyUI-render family (stills + transitions) when the workflow or
 * sampling changes. Now at 2 for the Wan 2.2 dual-expert chain (invalidates any one-expert renders).
 */
export const WORKFLOW_VERSION = 2;

/** Bump to invalidate the Piper TTS family when the engine or voices change. */
export const TTS_CACHE_VERSION = 1;
