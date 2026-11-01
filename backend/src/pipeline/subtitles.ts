import { presenterGeometry } from '../media/ffmpeg';

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

const LIBASS_PLAY_RES_X = 384; // ffmpeg's default libass script width; MarginL/R are in this space

export interface PresenterSubtitleStyleOptions {
  videoWidth: number;
  videoHeight: number;
  /** Crop box of each presenter (A bottom-left, B bottom-right); only w/h matter. */
  cropA: { w: number; h: number };
  cropB: { w: number; h: number };
  heightRatio?: number;
  marginRatio?: number;
  /** Free pixels kept between a presenter and the text. Default 18. */
  gapPx?: number;
}

/**
 * libass force_style (`MarginL=..,MarginR=..`) that keeps the burned subtitles in the free centre
 * column between the two presenters overlaid by presenterOverlayArgs. Presenter width is rounded
 * up to an even number (scale=-2) so the margin is never smaller than the real sprite.
 */
export function presenterSubtitleStyle(o: PresenterSubtitleStyleOptions): string {
  const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  if (!posInt(o.videoWidth)) throw new Error('presenterSubtitleStyle: videoWidth must be a positive integer');
  const gap = o.gapPx ?? 18;
  if (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0) throw new Error('presenterSubtitleStyle: gapPx must be a non-negative number');
  const { H, M } = presenterGeometry(o.videoHeight, o.heightRatio, o.marginRatio, 'presenterSubtitleStyle');
  const units = (name: string, crop: { w: number; h: number }) => {
    if (!crop || !Number.isInteger(crop.w) || !Number.isInteger(crop.h) || crop.w < 2 || crop.h < 2) {
      throw new Error(`presenterSubtitleStyle: ${name} must have integer w and h >= 2`);
    }
    const width = 2 * Math.ceil((H * crop.w) / crop.h / 2);
    return Math.ceil(((M + width + gap) * LIBASS_PLAY_RES_X) / o.videoWidth);
  };
  return `MarginL=${units('cropA', o.cropA)},MarginR=${units('cropB', o.cropB)}`;
}
