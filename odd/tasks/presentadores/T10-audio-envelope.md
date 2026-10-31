# T10 — audio envelope -> mouth states (pure, local)

## Goal
Presenters (phase 3A "volume" mode) open and close their mouth following the TTS audio. Build a pure module that turns a Piper WAV into a per-video-frame series of mouth states, and a helper that builds one timeline per presenter (A/B) across scenes. No ffmpeg, no GPU, no network.

## Files
- `backend/src/media/audioEnvelope.ts` (new)
- `backend/test/audioEnvelope.test.ts` (new)

## Reuse
`backend/src/media/wav.ts` already has `parseWav(buf)` (-> `{ format: {rate,width,channels}, dataOffset, dataLength }`), `wavFromPcm(pcm, fmt)` and `wavSilence(...)`. Use them (also in tests to build synthetic WAVs). Assume 16-bit PCM (`format.width === 2`); throw a clear Error otherwise. If `channels > 1`, use only the first channel.

## API
```ts
export type MouthState = 'closed' | 'mid' | 'open';
export interface MouthOptions { fps?: number; /* default 24 */ midThreshold?: number; /* default 0.04 */ openThreshold?: number; /* default 0.12 */ }
/** One state per video frame (ceil(durationSec * fps) entries). */
export function mouthStates(wav: Buffer, opts?: MouthOptions): MouthState[];

export interface SceneTrack { speaker?: 'A' | 'B'; states: MouthState[]; /** frames of silence after the scene (the gap that the assembler inserts) */ gapFrames: number; }
export interface PresenterTimelines { A: MouthState[]; B: MouthState[]; }
export function presenterTimelines(scenes: SceneTrack[]): PresenterTimelines;
```

## Behaviour
- Per frame, RMS of the samples in that frame's window, normalised to 0..1 (divide by 32768).
- Hysteresis so the mouth does not flicker: moving UP a level needs the RMS to exceed the threshold; moving DOWN needs it to fall below 70 % of that threshold. Start at `closed`.
- Empty/silent audio gives all `closed`. Frame count is `Math.ceil(durationSec * fps)`; an empty data chunk gives `[]`.
- `presenterTimelines`: for each scene, the speaking presenter gets `states` and the other one gets the same number of `'closed'` frames; both get `gapFrames` of `'closed'` after the scene. A scene with no `speaker` is treated as speaker `'A'`. Both timelines always have identical length.

## Tests (write first, must fail first)
Build WAVs with `wavFromPcm` from generated Int16 PCM (e.g. 16 kHz mono):
- silence -> all `closed`, length `ceil(sec*24)`.
- constant loud tone (amplitude ~0.5 full scale) -> mostly `open` after the first frame, never `closed` in the middle.
- quiet tone (~0.06) -> `mid`.
- burst pattern (loud 0.5 s, silence 0.5 s, loud 0.5 s) -> `open` ... `closed` ... `open`, and the hysteresis case: a signal hovering just under the open threshold after being open does NOT flicker (no `open`->`closed` jump on a single frame dip).
- `fps` option changes the length (12 fps -> half the frames).
- 8-bit WAV throws; stereo uses the first channel.
- `presenterTimelines`: two scenes (A then B) with `gapFrames: 3` -> lengths equal; A is `closed` during B's scene and vice versa; a scene without speaker goes to A.

## Acceptance
- `cd backend && node --test --import tsx test/audioEnvelope.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
Any other file (ffmpeg.ts, orchestrator, routes, frontend, wav.ts).

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
