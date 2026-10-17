import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  resolveEffectiveConfig,
  updateSettings,
  validateHostUrl,
  validatePiperHost,
  type EnvDefaults,
  type SettingsPatch,
} from '../config/settings';

const HOST_KEYS = ['comfyHost', 'ollamaHost', 'piperHost'] as const;

export function configRouter(db: DatabaseSync, envDefaults: EnvDefaults): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(resolveEffectiveConfig(db, envDefaults));
  });

  router.patch('/', (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'Body must be a JSON object' });
      return;
    }
    const patch: SettingsPatch = {};
    for (const key of HOST_KEYS) {
      const value = (body as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const valid = key === 'piperHost' ? validatePiperHost(value) : validateHostUrl(value);
      if (!valid) {
        const expected = key === 'piperHost' ? 'a tcp://host:port address' : 'an http or https URL';
        res.status(400).json({ error: `${key} must be ${expected}` });
        return;
      }
      patch[key] = value as string;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: `Body must include at least one of: ${HOST_KEYS.join(', ')}` });
      return;
    }
    updateSettings(db, patch);
    res.json(resolveEffectiveConfig(db, envDefaults));
  });

  return router;
}
