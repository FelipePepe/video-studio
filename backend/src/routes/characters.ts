import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { isComfyUnavailable } from '../clients/comfy';
import { analyzeCharacter, type AnalyzeDeps, type CharacterAnalysis } from '../media/characterAnalysis';
import { buildCharacterPrompt, type CharacterGenerator } from '../characters/characterGenerator';
import { isValidCharacterId, type Character, type CharacterRepository } from '../characters/characterRepository';

export interface CharactersDeps {
  repo: CharacterRepository;
  generate: CharacterGenerator;
  runFfmpegCapture: AnalyzeDeps['runFfmpegCapture'];
}

function toJson(c: Character) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    keyColor: c.keyColor,
    crop: c.crop,
    width: c.width,
    height: c.height,
    mouthY: c.mouthY,
    imageUrl: `/api/characters/${c.id}/image`,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function charactersRouter(deps: CharactersDeps): Router {
  const router = Router();
  let generating = false;

  /** Validates `:id` before any DB or filesystem access; answers 400 itself when invalid. */
  const validId = (req: Request, res: Response): string | undefined => {
    const id = req.params.id;
    if (!isValidCharacterId(id)) {
      res.status(400).json({ error: 'invalid character id' });
      return undefined;
    }
    return id;
  };

  router.post('/', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 80) return void res.status(400).json({ error: 'name is required' });
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    if (!description || description.length > 500) return void res.status(400).json({ error: 'description is required' });
    let seed: number;
    if (b.seed === undefined) {
      seed = randomBytes(4).readUInt32BE(0);
    } else if (typeof b.seed === 'number' && Number.isInteger(b.seed) && b.seed >= 0 && b.seed <= 4294967295) {
      seed = b.seed;
    } else {
      return void res.status(400).json({ error: 'seed must be an integer' });
    }

    if (generating) return void res.status(429).json({ error: 'a character is already being generated' });
    generating = true;
    try {
      const { prompt, negativePrompt } = buildCharacterPrompt(description);
      let png: Buffer;
      try {
        png = await deps.generate({ prompt, negativePrompt, seed });
      } catch (e) {
        if (isComfyUnavailable(e)) return void res.status(503).json({ error: 'ComfyUI unavailable' });
        return void res.status(502).json({ error: `character generation failed: ${errMsg(e)}` });
      }
      // ffmpeg needs a file, but the repository only learns the id (and writes the final file) in
      // create(), which needs the analysis. Analyse a server-named temp copy; the row and the
      // final file are created only after the analysis succeeds.
      const tmpDir = mkdtempSync(join(tmpdir(), 'character-'));
      let analysis: CharacterAnalysis;
      try {
        const tmpPng = join(tmpDir, 'character.png');
        writeFileSync(tmpPng, png);
        analysis = await analyzeCharacter(png, tmpPng, { runFfmpegCapture: deps.runFfmpegCapture });
      } catch (e) {
        return void res.status(422).json({ error: `could not analyse the generated image: ${errMsg(e)}` });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      const character = deps.repo.create({ name, description, seed, png, analysis });
      res.status(201).json(toJson(character));
    } finally {
      generating = false;
    }
  });

  router.get('/', (req, res) => {
    const status = req.query.status;
    if (status !== undefined && status !== 'approved' && status !== 'generated') {
      return void res.status(400).json({ error: 'status must be approved or generated' });
    }
    const all = deps.repo.list();
    res.json({ characters: (status ? all.filter((c) => c.status === status) : all).map(toJson) });
  });

  router.get('/:id', (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const c = deps.repo.get(id);
    if (!c) return void res.status(404).json({ error: 'character not found' });
    res.json(toJson(c));
  });

  router.get('/:id/image', (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const c = deps.repo.get(id);
    if (!c) return void res.status(404).json({ error: 'character not found' });
    res.type('image/png');
    res.sendFile(basename(c.imagePath), { root: dirname(c.imagePath) }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'character image not found' });
    });
  });

  router.post('/:id/approve', (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const mouthY = (req.body ?? {}).mouthY as unknown;
    if (mouthY !== undefined && (typeof mouthY !== 'number' || !Number.isFinite(mouthY) || mouthY < 0.05 || mouthY > 0.95)) {
      return void res.status(400).json({ error: 'mouthY must be a number between 0.05 and 0.95' });
    }
    const c = deps.repo.approve(id, mouthY === undefined ? {} : { mouthY });
    if (!c) return void res.status(404).json({ error: 'character not found' });
    res.json(toJson(c));
  });

  router.delete('/:id', (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    if (!deps.repo.remove(id)) return void res.status(404).json({ error: 'character not found' });
    res.status(204).end();
  });

  return router;
}
