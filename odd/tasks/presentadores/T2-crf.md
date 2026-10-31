# T2 — explicit CRF 18 on every intermediate encode

## Goal
Ken Burns, xfade and normalize clips are encoded with libx264 default CRF (23) and then joined with `concat -c copy`, so that CRF is the final quality. Make quality explicit and higher.

## Files
- `backend/src/media/ffmpeg.ts`
- `backend/test/ffmpeg.test.ts`
- `backend/test/vertical.test.ts` (only the existing assertions that hard-code `'-crf', '19'`)

## Changes
1. Add `export const VIDEO_CRF = 18;` near the top of ffmpeg.ts (doc comment: intermediate clips reach the final file via concat -c copy).
2. Add `'-crf', String(VIDEO_CRF)` right after `'-preset', 'veryfast'` in `kenBurnsArgs` and `normalizeClipArgs`, and after `'-c:v', 'libx264'` in `xfadeArgs` (add `'-preset', 'veryfast'` there too, keeping the order `-c:v libx264 -preset veryfast -crf N -pix_fmt yuv420p`).
3. In `burnSubtitlesArgs`, `verticalCropArgs`, `verticalBurnSubtitlesArgs` replace the literal `'19'` with `String(VIDEO_CRF)`.

## Tests (write first, must fail first)
- Import `VIDEO_CRF`. Assert `VIDEO_CRF === 18`.
- For kenBurnsArgs, xfadeArgs, normalizeClipArgs, burnSubtitlesArgs, verticalCropArgs, verticalBurnSubtitlesArgs: the args contain the pair `'-crf', '18'` (assert via `args[args.indexOf('-crf') + 1] === String(VIDEO_CRF)`).
- Update the existing deepEqual expectations (kenBurnsArgs defaults test, verticalCropArgs test, others that break) to the new arg lists.

## Acceptance
- `test/ffmpeg.test.ts` and `test/vertical.test.ts` green; `pnpm typecheck` green.
- No remaining literal `'19'` crf in ffmpeg.ts.

## Do NOT touch
Filters (-vf / filter_complex strings), `runFfmpeg`, music/mux/cover/concat builders, orchestrator.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Run tests only with: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.

