# T10b — per-clip normalisation for the mouth envelope

## Evidence
Real Piper clips (male 129 Hz vs female 195 Hz voice) have very different loudness: the 95th percentile of the per-frame RMS is 0.26-0.34 and the median 0.10-0.18. With the absolute default thresholds (0.04 / 0.12) the mouth is `open` in 50-74 % of the frames (looks gaping). Relative to each clip's own p95, the distribution is consistent across voices: >0.5 p95 = 37-52 % of frames, 0.15-0.5 p95 = 29-39 %, <0.15 p95 = 17-25 %.

## Goal
`mouthStates` gets an opt-in normalisation so the same thresholds work for any voice/loudness.

## Files
- `backend/src/media/audioEnvelope.ts`
- `backend/test/audioEnvelope.test.ts`

## Changes
1. `MouthOptions` gets `normalize?: boolean` (default `false`: current behaviour and existing tests unchanged).
2. When `normalize` is true: compute every frame's RMS first, then the reference = 95th percentile of those RMS values (sorted, index `Math.floor(0.95 * (n - 1))`). `midThreshold` / `openThreshold` are then fractions of that reference; when not given they default to `0.15` and `0.55` (export them as `NORMALIZED_MID_THRESHOLD` and `NORMALIZED_OPEN_THRESHOLD`). If the reference is below `0.005` (silence/noise floor) every frame is `closed`. The hysteresis (down at 70 % of the up threshold) is unchanged. The validation `0 < mid < open` still applies to the effective values.
3. Keep one code path for the state machine: compute the RMS series once, then run the same loop with `reference = 1` (not normalised) or the p95 (normalised).

## Tests (write first, must fail first)
- Build a speech-like clip (alternating 0.3 s loud / 0.2 s quiet / 0.2 s silence segments, 16 kHz mono) at amplitude A and the same clip scaled by 0.4: with `normalize: true` both give the SAME state sequence; with the default (`normalize` false) they differ.
- `normalize: true` on pure silence -> all `closed`; on near-silent noise (amplitude 0.002) -> all `closed`.
- `normalize: true` with explicit thresholds `{ midThreshold: 0.3, openThreshold: 0.8 }` uses them as fractions (a segment at 0.5 of the reference is `mid`).
- Existing tests stay green and unchanged.

## Acceptance
- `cd backend && node --test --import tsx test/audioEnvelope.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
Any other file.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
