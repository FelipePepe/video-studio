import { Router } from 'express';

/** Ollama clients may return bare names or /api/tags-shaped entries; the route normalizes both. */
export type ModelEntry = string | { name: string };

export interface OllamaModelsDeps {
  listModels: (signal?: AbortSignal) => Promise<ModelEntry[]> | ModelEntry[];
}

/**
 * GET /api/ollama/models
 *
 * Returns the available Ollama model names. Never throws to the HTTP layer:
 * a failed or absent Ollama returns `200 { models: [] }` so the UI can
 * gracefully fall back to a free-text box.
 */
export function ollamaModelsRouter(deps: OllamaModelsDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    let names: string[] = [];
    try {
      const result = await deps.listModels(controller.signal);
      if (Array.isArray(result)) {
        names = result
          .map((m) => (typeof m === 'string' ? m : m.name))
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
      }
    } catch {
      names = [];
    }
    res.json({ models: names });
  });

  return router;
}
