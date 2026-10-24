import fs from 'node:fs';
import path from 'node:path';

/** Audio extensions accepted as background music (case-insensitive). */
export const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.flac', '.m4a', '.wav'] as const;

export interface MusicFile {
  name: string;
  /** Absolute server path, ready to pass as the `music` approve option. */
  path: string;
  size: number;
  mtime: string;
}

export class MusicLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicLibraryError';
  }
}

function isAudioFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Lists the audio files of a directory, sorted by name (ASCII, case-sensitive).
 * Throws `MusicLibraryError` when `dir` is not an accessible directory.
 */
export function listMusicDir(dir: string): MusicFile[] {
  let entries: string[];
  try {
    if (!fs.statSync(dir).isDirectory()) {
      throw new MusicLibraryError(`Not a directory: ${dir}`);
    }
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (e instanceof MusicLibraryError) throw e;
    throw new MusicLibraryError(`Music directory not accessible: ${dir}`);
  }
  // Resolve the directory so every returned path is its true, symlink-free form.
  // Without this, a MUSIC_DIR under a symlink makes /approve reject the library's
  // own files (it compares against realpathSync(dir)) or hand out unstable paths.
  let root: string;
  try {
    root = fs.realpathSync(dir);
  } catch {
    throw new MusicLibraryError(`Music directory not accessible: ${dir}`);
  }
  const files = entries
    .filter(isAudioFile)
    .map((name) => {
      const full = path.join(root, name);
      const stat = fs.statSync(full);
      if (!stat.isFile()) return null;
      return { name, path: full, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .filter((f): f is MusicFile => f !== null);
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return files;
}
