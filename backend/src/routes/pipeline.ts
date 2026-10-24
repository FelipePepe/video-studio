import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep as pathSep } from 'node:path';
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { OllamaClient } from '../clients/ollama';
import { DraftInputError, DraftValidationError, generateDraft, validateEscaleta } from '../pipeline/draft';
import { createDraft, DraftLockedError, getDraft, markApproved, updateEscaleta } from '../pipeline/draftRepository';
import { generatePublishMetadata, PublishInputError } from '../pipeline/publish';
import { getLatestJobForDraft } from '../jobs/jobRepository';
import type { ApproveOptions } from '../pipeline/types';
import type { Job, JobEvent } from '../jobs/types';
import type { EventHub } from '../jobs/eventHub';
import type { JobRunner } from '../jobs/runner';
import { streamJobEvents } from './jobs';

export interface PipelineDeps {
  db: DatabaseSync;
  resolveOllama: () => OllamaClient;
  fetchImpl?: typeof fetch;
  runner: JobRunner;
  hub: EventHub;
  heartbeatMs?: number;
  /** Music library root — music paths at approve must live inside this dir. Empty = library disabled. */
  musicDir?: () => string;
}

class ApproveOptionsError extends Error {}

function parseApproveOptions(body: unknown, musicDir?: string): ApproveOptions | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApproveOptionsError('Body must be a JSON object');
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'music' && key !== 'musicVolume' && key !== 'subtitles' && key !== 'vertical' && key !== 'style' && key !== 'useLightx2v') throw new ApproveOptionsError(`Unknown approve option: ${key}`);
  }
  if (Object.keys(o).length === 0) return null;
  const opts: ApproveOptions = {};
  if (o.music !== undefined) {
    if (typeof o.music !== 'string' || o.music.length === 0) throw new ApproveOptionsError('music must be a non-empty path');
    const dir = (musicDir ?? '').trim();
    if (!dir) throw new ApproveOptionsError('music must come from a configured library (set MUSIC_DIR)');
    const allowedRoot = realpathSync(resolve(dir));
    // Resolve the file too: a symlink pointing outside the library resolves to
    // its real location (rejected below) and a MUSIC_DIR reached via symlinks
    // accepts the library's own files.
    let musicFile: string;
    try {
      musicFile = realpathSync(resolve(o.music));
    } catch {
      throw new ApproveOptionsError(`Music file not found: ${o.music}`);
    }
    const rel = relative(allowedRoot, musicFile);
    // '..' or '../x' escape the library; '..foo.mp3' is a legitimate file name.
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + pathSep)) {
      throw new ApproveOptionsError('music path escapes the configured music library directory');
    }
    if (!statSync(musicFile).isFile()) throw new ApproveOptionsError(`Music path is not a file: ${o.music}`);
    opts.music = musicFile;
  }
  if (o.musicVolume !== undefined) {
    if (typeof o.musicVolume !== 'number' || !Number.isFinite(o.musicVolume) || o.musicVolume <= 0 || o.musicVolume > 1) {
      throw new ApproveOptionsError('musicVolume must be a number in (0, 1]');
    }
    opts.musicVolume = o.musicVolume;
  }
  if (o.subtitles !== undefined) {
    if (typeof o.subtitles !== 'boolean') throw new ApproveOptionsError('subtitles must be a boolean');
    opts.subtitles = o.subtitles;
  }
  if (o.vertical !== undefined) {
    if (typeof o.vertical !== 'boolean') throw new ApproveOptionsError('vertical must be a boolean');
    opts.vertical = o.vertical;
  }
  if (o.style !== undefined) {
    if (typeof o.style !== 'string' || o.style.trim().length === 0) throw new ApproveOptionsError('style must be a non-empty string');
    opts.style = o.style.trim();
  }
  if (o.useLightx2v !== undefined) {
    if (typeof o.useLightx2v !== 'boolean') throw new ApproveOptionsError('useLightx2v must be a boolean');
    opts.useLightx2v = o.useLightx2v;
  }
  return opts;
}

export function pipelineRouter(deps: PipelineDeps): Router {
  const router = Router();

  router.post('/draft', async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'Body must be a JSON object' });
      return;
    }
    try {
      const generated = await generateDraft(body, {
        ollama: deps.resolveOllama(),
        fetchImpl: deps.fetchImpl,
      });
      const draft = createDraft(deps.db, generated);
      res.status(201).json({ id: draft.id, escaleta: draft.escaleta, status: draft.status });
    } catch (e) {
      if (e instanceof DraftInputError) {
        res.status(400).json({ error: e.message });
        return;
      }
      // Article fetch, Ollama and invalid model output are all upstream failures.
      res.status(502).json({ error: (e as Error).message });
    }
  });

  router.get('/draft/:id', (req, res) => {
    const draft = getDraft(deps.db, req.params.id);
    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }
    res.json(draft);
  });

  // doc §7 — publication metadata (title/description/tags/hashtags + hook + cta) for the draft's video.
  router.get('/draft/:id/publish', async (req, res) => {
    const draft = getDraft(deps.db, req.params.id);
    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }
    try {
      const meta = await generatePublishMetadata(
        { language: draft.language, escaleta: draft.escaleta },
        { ollama: deps.resolveOllama() },
      );
      res.json(meta);
    } catch (e) {
      if (e instanceof PublishInputError) {
        res.status(422).json({ error: e.message });
        return;
      }
      res.status(502).json({ error: 'publish metadata generation failed' });
    }
  });

  router.put('/draft/:id/segments', (req, res) => {
    const draft = getDraft(deps.db, req.params.id);
    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }
    try {
      const escaleta = validateEscaleta(
        { scenes: (req.body as { escaleta?: unknown } | undefined)?.escaleta },
        { voiceA: draft.voiceA, voiceB: draft.voiceB, mix: draft.mix, keepVoices: true },
      );
      res.json(updateEscaleta(deps.db, draft.id, escaleta));
    } catch (e) {
      if (e instanceof DraftValidationError) res.status(400).json({ error: e.message });
      else if (e instanceof DraftLockedError) res.status(409).json({ error: e.message });
      else throw e;
    }
  });

  /**
   * Approves a draft and starts its job. By default the response is an SSE stream whose
   * first event is `{ type: 'stage', stage: 'queued', jobId }`; clients can reconnect with
   * GET /api/jobs/:id/events. Only `type` and `jobId` are guaranteed on every event (a
   * `done` event may omit fields), so read the rest with optional chaining. Closing the
   * stream does not cancel the job. `Accept: application/json` returns 202 `{ jobId }`.
   */
  router.post('/draft/:id/approve', (req, res) => {
    let opts: ApproveOptions | null;
    try {
      opts = parseApproveOptions(req.body, deps.musicDir?.());
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid approve options' });
      return;
    }
    let job: Job;
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      const draft = getDraft(deps.db, req.params.id);
      if (!draft) {
        deps.db.exec('ROLLBACK');
        res.status(404).json({ error: 'Draft not found' });
        return;
      }
      if (draft.status === 'draft') {
        markApproved(deps.db, draft.id);
      } else {
        // Already approved: only a failed or cancelled latest job may be retried.
        const latest = getLatestJobForDraft(deps.db, draft.id);
        if (latest && latest.status !== 'failed' && latest.status !== 'cancelled') {
          deps.db.exec('ROLLBACK');
          res.status(409).json({ error: `Draft is already ${draft.status}` });
          return;
        }
      }
      job = deps.runner.createJob(draft.id, opts);
      deps.db.exec('COMMIT');
    } catch (e) {
      deps.db.exec('ROLLBACK');
      throw e;
    }
    deps.runner.schedule(job);
    if (req.get('Accept')?.includes('application/json')) {
      res.status(202).json({ jobId: job.id });
      return;
    }
    const queued: JobEvent = { type: 'stage', stage: 'queued', jobId: job.id, progress: 0, at: job.createdAt };
    streamJobEvents(res, { hub: deps.hub, heartbeatMs: deps.heartbeatMs }, job, queued);
  });

  return router;
}
