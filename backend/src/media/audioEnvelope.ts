import { parseWav, type PcmFormat } from './wav';

/**
 * Discrete mouth states driven by the audio envelope of a TTS clip.
 * Pure and local: no ffmpeg, no GPU, no network. See test/audioEnvelope.test.ts.
 */

export type MouthState = 'closed' | 'mid' | 'open';

/**
 * Default fractions of the p95 loudness reference when `normalize` is on: 'mid' and 'open'.
 * Tuned on real Piper clips (male and female voice): ~20 % closed, ~50 % mid, ~25 % open, and the
 * same split for both voices. Lower values leave the mouth gaping most of the time.
 */
export const NORMALIZED_MID_THRESHOLD = 0.22;
export const NORMALIZED_OPEN_THRESHOLD = 0.8;

/** Below this p95 reference the clip is treated as silence/noise floor: every frame is 'closed'. */
const SILENCE_REFERENCE_FLOOR = 0.005;

export interface MouthOptions {
  /** Video frame rate. Default 24. */
  fps?: number;
  /**
   * When true, the thresholds are fractions of the clip's own 95th-percentile
   * per-frame RMS, so the same thresholds work for any voice/loudness.
   * Default false (absolute RMS thresholds, previous behaviour).
   */
  normalize?: boolean;
  /**
   * RMS above which the mouth moves UP into 'mid'.
   * Default 0.04 (absolute), or NORMALIZED_MID_THRESHOLD when `normalize` is on.
   */
  midThreshold?: number;
  /**
   * RMS above which the mouth moves UP into 'open'.
   * Default 0.12 (absolute), or NORMALIZED_OPEN_THRESHOLD when `normalize` is on.
   */
  openThreshold?: number;
}

const LEVELS: MouthState[] = ['closed', 'mid', 'open'];

interface ResolvedMouthOptions {
  fps: number;
  normalize: boolean;
  midThreshold: number;
  openThreshold: number;
}

function resolve(options: MouthOptions | undefined): ResolvedMouthOptions {
  const fps = options?.fps ?? 24;
  const normalize = options?.normalize ?? false;
  const midThreshold = options?.midThreshold ?? (normalize ? NORMALIZED_MID_THRESHOLD : 0.04);
  const openThreshold = options?.openThreshold ?? (normalize ? NORMALIZED_OPEN_THRESHOLD : 0.12);
  if (!(fps > 0)) throw new Error('fps must be greater than 0');
  if (!(midThreshold > 0) || !(openThreshold > midThreshold)) {
    throw new Error('thresholds must satisfy 0 < midThreshold < openThreshold');
  }
  return { fps, normalize, midThreshold, openThreshold };
}

function rmsOf(samples: Int16Array, start: number, end: number): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / (end - start)) / 32768;
}

/**
 * Turn a 16-bit PCM WAV into one mouth state per video frame.
 *
 * Per frame: RMS of the samples in the frame window, normalised to 0..1.
 * Hysteresis so the mouth does not flicker — moving UP one level requires
 * the RMS to exceed that level's threshold; moving DOWN one level requires it
 * to fall below 70 % of that threshold. Starts at 'closed'.
 *
 * With `normalize: true` the thresholds are fractions of the clip's own
 * 95th-percentile per-frame RMS, so they work for any voice/loudness; a
 * reference below 0.005 (silence/noise floor) yields all 'closed'.
 */
export function mouthStates(wav: Buffer, opts?: MouthOptions): MouthState[] {
  const { fps, normalize, midThreshold, openThreshold } = resolve(opts);
  const parsed = parseWav(wav);
  if (parsed.format.width !== 2) {
    throw new Error(`Only 16-bit PCM WAV is supported (got ${parsed.format.width * 8}-bit)`);
  }
  const { rate, channels } = parsed.format as PcmFormat;
  if (parsed.dataLength === 0) return [];

  const sampleCount = Math.floor(parsed.dataLength / 2) / channels;
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = wav.readInt16LE(parsed.dataOffset + i * 2 * channels);
  }

  const durationSec = sampleCount / rate;
  const frameCount = Math.ceil(durationSec * fps);

  // One code path: compute the RMS series once, then pick the reference.
  const rms: number[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = Math.floor((f * rate) / fps);
    const end = Math.min(Math.floor(((f + 1) * rate) / fps), sampleCount);
    rms[f] = rmsOf(samples, start, end);
  }

  let reference = 1;
  if (normalize) {
    const sorted = [...rms].sort((a, b) => a - b);
    reference = sorted[Math.floor(0.95 * (sorted.length - 1))];
    if (reference < SILENCE_REFERENCE_FLOOR) {
      return new Array(frameCount).fill('closed') as MouthState[];
    }
  }

  const upThresholds = [0, midThreshold * reference, openThreshold * reference];
  const downThresholds = [0, midThreshold * reference * 0.7, openThreshold * reference * 0.7];

  const states: MouthState[] = new Array(frameCount);
  let level = 0;
  for (let f = 0; f < frameCount; f++) {
    const frameRms = rms[f];
    while (level < 2 && frameRms > upThresholds[level + 1]) level += 1;
    while (level > 0 && frameRms < downThresholds[level]) level -= 1;
    states[f] = LEVELS[level];
  }
  return states;
}

export interface SceneTrack {
  /** Who speaks in this scene. Absent = 'A'. */
  speaker?: 'A' | 'B';
  states: MouthState[];
  /** Frames of silence after the scene (the gap that the assembler inserts). */
  gapFrames: number;
}

export interface PresenterTimelines {
  A: MouthState[];
  B: MouthState[];
}

/**
 * Build one mouth-state timeline per presenter (A/B) across scenes.
 * The speaking presenter gets `states`; the other gets the same number of
 * 'closed' frames; both get `gapFrames` of 'closed' after the scene.
 * A scene without a speaker is treated as 'A'. Timelines are always equal length.
 */
export function presenterTimelines(scenes: SceneTrack[]): PresenterTimelines {
  const A: MouthState[] = [];
  const B: MouthState[] = [];
  for (const scene of scenes) {
    const speaker = scene.speaker ?? 'A';
    if (!Number.isInteger(scene.gapFrames) || scene.gapFrames < 0) {
      throw new Error('gapFrames must be a non-negative integer');
    }
    A.push(
      ...(speaker === 'A' ? scene.states : closed(scene.states.length)),
      ...closed(scene.gapFrames),
    );
    B.push(
      ...(speaker === 'B' ? scene.states : closed(scene.states.length)),
      ...closed(scene.gapFrames),
    );
  }
  return { A, B };
}

function closed(n: number): MouthState[] {
  return new Array(n).fill('closed');
}
