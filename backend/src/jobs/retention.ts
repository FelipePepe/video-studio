import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export interface RetentionJob {
  id: string;
  status: string;
  /** ISO timestamp or null (unfinished). */
  finishedAt: string | null;
}

export interface RetentionConfig {
  /** Don't touch jobs that finished within the last N ms of `now`. Default 7 days. `0` disables age rule. */
  minAgeMs?: number;
  /** Always keep the N most recent FINISHED jobs. Default 10. `0` disables. */
  keepRecent?: number;
}

const ACTIVE = new Set(['queued', 'running']);

/**
 * Pure planner: given the jobIds that have a directory under the work dir and the list of
 * jobs the system knows about, returns the jobIds SAFE to delete. Rules (all must hold):
 *
 *   - the job is NOT active (queued/running);
 *   - the job is NOT in the N most recent finished (regardless of age);
 *   - the job's finished_at is present AND older than minAgeMs;
 *   - we actually have the job in the known list (defensive: unknown ids are kept).
 *
 * Being explicit about the "known ids" input lets callers pass a different `existingDirs`
 * view (e.g. for tests or a custom scan root).
 */
export function planRetention(
  existingDirIds: string[],
  jobs: RetentionJob[],
  cfg: RetentionConfig = {},
  now: number = Date.now(),
): string[] {
  const minAgeMs = cfg.minAgeMs ?? 7 * 24 * 3600 * 1000;
  const keepRecent = cfg.keepRecent ?? 10;

  const finished = jobs
    .filter((j) => !ACTIVE.has(j.status))
    .filter((j) => j.finishedAt)
    .sort((a, b) => (b.finishedAt as string).localeCompare(a.finishedAt as string));
  const keepIds = new Set(finished.slice(0, keepRecent).map((j) => j.id));

  const byId = new Map(jobs.map((j) => [j.id, j]));
  const out: string[] = [];
  for (const id of existingDirIds) {
    const j = byId.get(id);
    if (!j) continue;
    if (ACTIVE.has(j.status) || keepIds.has(id)) continue;
    const t = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
    if (!Number.isFinite(t)) continue;
    if (now - t < minAgeMs) continue;
    out.push(id);
  }
  return out;
}

/**
 * Read the work dir, plan, delete, and return the job ids actually removed.
 * Safe to call from multiple places: uses `planRetention` as the single source of truth.
 */
export function pruneWorkDirs(
  workDir: string,
  jobs: RetentionJob[],
  cfg: RetentionConfig = {},
  now: number = Date.now(),
): { pruned: string[] } {
  if (!isAbsolute(workDir)) workDir = join(process.cwd(), workDir);
  if (!existsSync(workDir)) return { pruned: [] };
  const entries = readdirSync(workDir, { withFileTypes: true });
  const dirIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const toDelete = planRetention(dirIds, jobs, cfg, now);
  const pruned: string[] = [];
  for (const id of toDelete) {
    try {
      rmSync(join(workDir, id), { recursive: true, force: true });
      pruned.push(id);
    } catch {
      // best-effort: a prune failure must not break startup
    }
  }
  return { pruned };
}

/** Convenience: reads a small config from env and returns a `{ minAgeMs, keepRecent }`. */
export function retentionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const parse = (v: string | undefined): number | undefined => {
    if (v == null) return undefined;
    const s = v.trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const cfg: RetentionConfig = {};
  const days = parse(env.RETENTION_MIN_AGE_DAYS);
  const keep = parse(env.RETENTION_KEEP_RECENT);
  if (days !== undefined) cfg.minAgeMs = days * 24 * 3600 * 1000;
  if (keep !== undefined) cfg.keepRecent = keep;
  return cfg;
}
