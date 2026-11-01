import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CharacterAnalysis, MouthBox } from '../media/characterAnalysis';
import type { Clock } from '../pipeline/draftRepository';
import type { IdFactory } from '../jobs/jobRepository';

export const CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidCharacterId = (id: unknown): id is string => typeof id === 'string' && CHARACTER_ID_RE.test(id);

export type CharacterStatus = 'generated' | 'approved';

export interface Character {
  id: string;
  name: string;
  description: string;
  seed: number;
  imagePath: string;
  keyColor: string;
  crop: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  mouthY: number | null;
  /** Lips box in full-image px; null when not detected. */
  mouth: MouthBox | null;
  status: CharacterStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterRepository {
  /** Writes the PNG, then inserts the row. */
  create(input: { name: string; description: string; seed: number; png: Buffer; analysis: CharacterAnalysis }): Character;
  get(id: string): Character | undefined;
  /** Newest first. */
  list(): Character[];
  /** Rewrites key colour, crop, size and mouth from a fresh analysis. Null when the id is invalid or unknown. */
  updateAnalysis(id: string, analysis: CharacterAnalysis): Character | null;
  approve(id: string, opts?: { mouthY?: number }): Character | undefined;
  /** Deletes the row and the `<id>/` directory. */
  remove(id: string): boolean;
}

interface CharacterRow {
  id: string;
  name: string;
  description: string;
  seed: number;
  image_path: string;
  key_color: string;
  crop: string;
  width: number;
  height: number;
  mouth_y: number | null;
  mouth: string | null;
  status: CharacterStatus;
  created_at: string;
  updated_at: string;
}

function fromRow(r: CharacterRow): Character {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    seed: r.seed,
    imagePath: r.image_path,
    keyColor: r.key_color,
    crop: JSON.parse(r.crop) as Character['crop'],
    width: r.width,
    height: r.height,
    mouthY: r.mouth_y,
    mouth: r.mouth ? (JSON.parse(r.mouth) as MouthBox) : null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createCharacterRepository(
  db: DatabaseSync,
  charactersDir: string,
  deps: { clock?: Clock; newId?: IdFactory } = {},
): CharacterRepository {
  const root = resolve(charactersDir);
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  /** Directory of a validated id, asserted to live inside `root`. */
  function dirFor(id: string): string {
    if (!isValidCharacterId(id)) throw new Error('invalid character id');
    const dir = resolve(root, id);
    if (!dir.startsWith(root + sep)) throw new Error('character path escapes the characters directory');
    return dir;
  }

  const get = (id: string): Character | undefined => {
    if (!isValidCharacterId(id)) return undefined;
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as unknown as CharacterRow | undefined;
    return row ? fromRow(row) : undefined;
  };

  return {
    create({ name, description, seed, png, analysis }) {
      const id = newId();
      const dir = dirFor(id);
      if (get(id)) throw new Error(`character "${id}" already exists`);
      const imagePath = join(dir, 'character.png');
      const ts = clock().toISOString();
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(imagePath, png);
        db.prepare(
          `INSERT INTO characters (id, name, description, seed, image_path, key_color, crop, width, height, mouth_y, mouth, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'generated', ?, ?)`,
        ).run(id, name, description, seed, imagePath, analysis.keyColor, JSON.stringify(analysis.crop), analysis.width, analysis.height, analysis.mouth ? JSON.stringify(analysis.mouth) : null, ts, ts);
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        throw e;
      }
      return get(id) as Character;
    },
    get,
    list() {
      const rows = db.prepare('SELECT * FROM characters ORDER BY created_at DESC, rowid DESC').all() as unknown as CharacterRow[];
      return rows.map(fromRow);
    },
    updateAnalysis(id, analysis) {
      if (!get(id)) return null;
      db.prepare('UPDATE characters SET key_color = ?, crop = ?, width = ?, height = ?, mouth = ?, updated_at = ? WHERE id = ?').run(
        analysis.keyColor,
        JSON.stringify(analysis.crop),
        analysis.width,
        analysis.height,
        analysis.mouth ? JSON.stringify(analysis.mouth) : null,
        clock().toISOString(),
        id,
      );
      return get(id) ?? null;
    },
    approve(id, opts = {}) {
      if (!get(id)) return undefined;
      const ts = clock().toISOString();
      if (opts.mouthY !== undefined) {
        db.prepare("UPDATE characters SET status = 'approved', mouth_y = ?, updated_at = ? WHERE id = ?").run(opts.mouthY, ts, id);
      } else {
        db.prepare("UPDATE characters SET status = 'approved', updated_at = ? WHERE id = ?").run(ts, id);
      }
      return get(id);
    },
    remove(id) {
      if (!get(id)) return false;
      const dir = dirFor(id);
      db.prepare('DELETE FROM characters WHERE id = ?').run(id);
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
  };
}
