# T4 — 9:16 output without upscaling the subject

## Goal
Today vertical output is `crop=ih*9/16:ih,scale=720:1280`: it keeps a 405x720 strip and upscales it 1.78x. Replace it with "fit with blurred background": the full 16:9 frame scaled to 720 wide, centered over a blurred, cropped copy of itself filling 720x1280. Still ONE x264 pass; the subtitles filter stays last.

## Files
- `backend/src/media/ffmpeg.ts` (only `verticalCropArgs`, `verticalBurnSubtitlesArgs`, plus a new shared helper)
- `backend/test/vertical.test.ts`
- `backend/test/ffmpeg.test.ts` (only the existing assertions that hard-code `crop=ih*9/16:ih,scale=720:1280`, around lines 188 and 198, for `verticalBurnSubtitlesArgs`/`burnSubtitlesArgs` vertical cases)

## Changes
1. Add a non-exported helper `verticalFitFilter(): string` returning a filter_complex fragment that takes the input video and outputs label `[v]`:
   `[0:v]split=2[bg][fg];[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:2[b];[fg]scale=720:-2[f];[b][f]overlay=(W-w)/2:(H-h)/2[v]`
2. `verticalCropArgs`: use `'-filter_complex', verticalFitFilter()`, `'-map', '[v]', '-map', '0:a?'` and keep the rest (libx264 veryfast, crf, yuv420p, `-c:a copy`).
3. `verticalBurnSubtitlesArgs`: same, but the fragment ends with the subtitle filter chained on the overlay output, i.e. `...overlay=(W-w)/2:(H-h)/2[o];[o]${subtitleFilter(o.srt, o.style)}[v]`. Build it by composing the helper (parametrise it with an optional trailing filter) rather than duplicating strings.
Keep function names and signatures unchanged (callers in the orchestrator must not change). Update the doc comments (they say "crop").

## Tests (write first, must fail first)
In `vertical.test.ts`:
- Replace the existing `verticalCropArgs` deepEqual with the new arg list.
- `verticalCropArgs`: contains `-filter_complex`, the filter contains `boxblur` and `overlay`, and does NOT contain `crop=ih*9/16`; maps `[v]`.
- `verticalBurnSubtitlesArgs`: the filter contains `subtitles=` AFTER `overlay` (index comparison), exactly one `libx264`.
- Any other existing test in the file or in `orchestrator*.test.ts` that asserts the old `crop=ih*9/16` string: update it (grep first; if it is outside the listed files, report it instead of editing). `ffmpeg.test.ts` IS in scope for this.

## Acceptance
- `node --test --import tsx test/vertical.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
Orchestrator, other ffmpeg builders, the fps/CRF values.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Run tests only with: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.

