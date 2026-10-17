export interface SubtitleCue {
  text: string;
  startSec: number;
  endSec: number;
}

function fmtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (v: number, w: number) => String(v).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(r, 3)}`;
}

/** Serializes cues as an SRT document. Throws on empty or malformed cues. */
export function buildSrt(cues: SubtitleCue[]): string {
  if (cues.length === 0) throw new Error('buildSrt needs at least one cue');
  const out: string[] = [];
  for (const [i, c] of cues.entries()) {
    const text = c.text.trim();
    if (text.length === 0) throw new Error(`Subtitle cue ${i + 1} has empty text`);
    if (!Number.isFinite(c.startSec) || c.startSec < 0) throw new Error(`Subtitle cue ${i + 1} has an invalid start`);
    if (!Number.isFinite(c.endSec) || c.endSec <= c.startSec) throw new Error(`Subtitle cue ${i + 1} must end after it starts`);
    out.push(`${i + 1}\n${fmtTime(c.startSec)} --> ${fmtTime(c.endSec)}\n${text}\n`);
  }
  return out.join('\n');
}

/**
 * Timeline cue math for the assembled film: scene i starts after every
 * previous scene duration plus the transition silences between scenes.
 */
/**
 * Timeline cue math for the assembled film: scene i starts after every
 * previous scene duration, plus the transition silences that were actually
 * inserted (`transitionPresent[i]` gates the silence after scene i; default
 * is every transition present).
 */
export function sceneCues(
  sceneSeconds: number[],
  transitionSec: number,
  texts: string[],
  transitionPresent: boolean[] = [],
): SubtitleCue[] {
  if (sceneSeconds.length !== texts.length) throw new Error('sceneCues: durations and texts must match');
  const gaps = sceneSeconds.length - 1;
  if (transitionPresent.length > 0 && transitionPresent.length !== gaps) {
    throw new Error(`sceneCues: transitionPresent must gate every gap (expected ${gaps}, got ${transitionPresent.length})`);
  }
  const cues: SubtitleCue[] = [];
  let t = 0;
  for (let i = 0; i < sceneSeconds.length; i++) {
    const dur = sceneSeconds[i];
    if (!Number.isFinite(dur) || dur <= 0) throw new Error(`sceneCues: invalid scene ${i + 1} duration`);
    cues.push({ text: texts[i], startSec: t, endSec: t + dur });
    t += dur;
    if (i < gaps && (transitionPresent.length === 0 || transitionPresent[i])) t += transitionSec;
  }
  return cues;
}
