import { existsSync } from 'node:fs';
import type { PresenterAssets } from '../pipeline/orchestrator';
import { isValidCharacterId, type CharacterRepository } from './characterRepository';

/** Resolves a character id to its approved image and analysis. Rejections become a pipeline warning (T14). */
export function createPresenterAssets(
  repo: Pick<CharacterRepository, 'get'>,
  exists: (p: string) => boolean = existsSync,
): (characterId: string) => Promise<PresenterAssets> {
  return async (characterId) => {
    if (!isValidCharacterId(characterId)) throw new Error('invalid character id');
    const c = repo.get(characterId);
    if (!c) throw new Error(`character "${characterId}" not found`);
    if (c.status !== 'approved') throw new Error(`character "${characterId}" is not approved`);
    if (!exists(c.imagePath)) throw new Error(`character "${characterId}" image is missing`);
    return {
      imagePath: c.imagePath,
      keyColor: c.keyColor,
      crop: c.crop,
      ...(c.mouthY !== null ? { mouthY: c.mouthY } : {}),
      ...(c.mouth !== null ? { mouth: c.mouth } : {}),
    };
  };
}
