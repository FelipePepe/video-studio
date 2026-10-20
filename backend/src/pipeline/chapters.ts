import type { Escaleta } from './types';

export interface Chapter {
  index: number;
  title: string;
  startSec: number;
  durationSec: number;
}

/**
 * Build chapter markers aligned to the muxed video timeline:
 * [narr0][trans0][narr1][trans1]… A chapter's duration is its scene's
 * narration duration; the start accumulates the preceding narrations and
 * the short I2V transitions that sit between them. This yields stable,
 * seekable chapter positions for the final deliverable.
 */
export function buildChapters(
  escaleta: Escaleta,
  durations: number[],
  transitionSec: number,
  hasTransition: (i: number) => boolean,
): Chapter[] {
  const chapters: Chapter[] = [];
  let cursor = 0;
  escaleta.forEach((scene, i) => {
    const dur = Math.max(0, durations[i] ?? 0);
    chapters.push({ index: i, title: scene.title, startSec: round(cursor), durationSec: round(dur) });
    cursor += dur;
    if (i < escaleta.length - 1 && hasTransition(i)) cursor += transitionSec;
  });
  return chapters;
}

const round = (x: number) => Math.round(x * 100) / 100;
