import type { Escaleta, Scene } from '../api/types';

/** Caps mirroring backend/src/pipeline/draft.ts (`validateEscaleta`); the backend stays the authority. */
export const MAX_SCENES = 20;
export const MAX_TITLE = 120;
export const MAX_NARRATION = 1200;
export const MAX_VISUAL = 600;

export type TextField = 'title' | 'narration' | 'visualPrompt';
export type FieldError = 'empty' | 'tooLong';
export type SceneErrors = Partial<Record<TextField, FieldError>>;

export const FIELD_LIMITS: Record<TextField, number> = {
  title: MAX_TITLE,
  narration: MAX_NARRATION,
  visualPrompt: MAX_VISUAL,
};

const FIELDS = Object.keys(FIELD_LIMITS) as TextField[];

/** The backend trims before validating, so validation measures the trimmed text. */
export function sceneErrors(scene: Scene): SceneErrors {
  const errors: SceneErrors = {};
  for (const field of FIELDS) {
    const text = scene[field].trim();
    if (!text) errors[field] = 'empty';
    else if (text.length > FIELD_LIMITS[field]) errors[field] = 'tooLong';
  }
  return errors;
}

export function isEscaletaValid(escaleta: Escaleta): boolean {
  return escaleta.length >= 1 && escaleta.length <= MAX_SCENES && escaleta.every((s) => Object.keys(sceneErrors(s)).length === 0);
}

export function renumber(escaleta: Escaleta): Escaleta {
  return escaleta.map((s, i) => (s.scene === i + 1 ? s : { ...s, scene: i + 1 }));
}

export function emptyScene(voice: Scene['voice']): Scene {
  return { scene: 0, title: '', narration: '', visualPrompt: '', voice };
}

/** Whitespace-insensitive comparison: the backend stores trimmed text. */
export function sameEscaleta(a: Escaleta, b: Escaleta): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const o = b[i]!;
    return (
      s.scene === o.scene &&
      s.voice === o.voice &&
      s.title.trim() === o.title.trim() &&
      s.narration.trim() === o.narration.trim() &&
      s.visualPrompt.trim() === o.visualPrompt.trim()
    );
  });
}
