# T3 — Ken Burns without jitter

## Goal
`zoompan` rounds its x/y to integers, so a 2× oversampled input jitters visibly. Oversample 4× and use the lanczos scaler for the pre-scale.

## Files
- `backend/src/media/ffmpeg.ts` (only `kenBurnsArgs`)
- `backend/test/ffmpeg.test.ts`

## Changes
In `kenBurnsArgs`, change the pre-scale/crop from `width*2 x height*2` to `width*4 x height*4`, and add `:flags=lanczos` to the scale filter:
`scale=${width*4}:${height*4}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width*4}:${height*4},zoompan=...` (zoompan expression, `s=${width}x${height}`, fps and format unchanged).
Add a short comment explaining why (integer rounding in zoompan).

## Tests (write first, must fail first)
- Update the "builds a zoompan clip with defaults" deepEqual: defaults 1280x720 now give `scale=5120:2880:force_original_aspect_ratio=increase:flags=lanczos,crop=5120:2880,zoompan=...` (keep the T2 `-crf 18` pair if already present in the file).
- Add: with width 640, height 360 the vf contains `scale=2560:1440` and `flags=lanczos`.

## Acceptance
- `test/ffmpeg.test.ts` green; `pnpm typecheck` green.
- In your report, state that the encode-time measurement (10 s clip before/after) is NOT done by you; Claude will do it.

## Do NOT touch
Other builders, the zoom expression, the CRF/preset args.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Run tests only with: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.

