import { Router } from 'express';
import type { PiperVoice } from '../clients/piper';

const LANG_RE = /^[a-z]{2,3}(-[a-z]{2,4})?(?=$)/i;

export interface VoicesDeps {
  /** Live roster from the Piper server; reject when unreachable. */
  listVoices: () => Promise<PiperVoice[]>;
}

/** GET /voices — Piper roster, optionally filtered with `?lang=es`. */
export function voicesRouter(deps: VoicesDeps): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const raw = req.query.lang;
    if (raw !== undefined) {
      const lang = String(raw);
      if (!LANG_RE.test(lang)) {
        res.status(400).json({ error: "lang must look like 'es' or 'es-ES'" });
        return;
      }
      try {
        const all = await deps.listVoices();
        const body = all.filter((v) => v.name.toLowerCase().startsWith(lang.toLowerCase()));
        res.json(body);
      } catch (e) {
        res.status(503).json({ error: e instanceof Error ? e.message : 'Piper unreachable' });
      }
      return;
    }
    try {
      res.json(await deps.listVoices());
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : 'Piper unreachable' });
    }
  });
  return router;
}
