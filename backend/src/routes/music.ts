import { Router } from 'express';
import { listMusicDir, MusicLibraryError } from '../lib/musicLibrary';

export interface MusicDeps {
  /** Directory to serve as the music library; empty string = library disabled. */
  musicDir: () => string;
}

export function musicRouter(deps: MusicDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const dir = deps.musicDir();
    if (!dir) {
      res.status(404).json({ error: 'Music library not configured (set MUSIC_DIR)' });
      return;
    }
    try {
      res.json({ musicDir: dir, files: listMusicDir(dir) });
    } catch (e) {
      if (e instanceof MusicLibraryError) {
        res.status(404).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  return router;
}
