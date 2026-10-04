import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { OllamaClient } from '../clients/ollama';
import { DraftInputError, DraftValidationError, generateDraft, validateEscaleta } from '../pipeline/draft';
import { createDraft, DraftLockedError, getDraft, updateEscaleta } from '../pipeline/draftRepository';

export interface PipelineDeps {
  db: DatabaseSync;
  resolveOllama: () => OllamaClient;
  fetchImpl?: typeof fetch;
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

  return router;
}
