# T11b — presenterClipArgs must output exactly N frames

## Evidence (real ffmpeg run, 221-frame timeline from a Piper clip)
The concat-demuxer script sums to exactly 221 frames, but `ffmpeg -f concat ... -vf fps=24,format=argb -c:v qtrle` produced 230 frames (with the repeated last `file` line) or 214 (without it): image-sequence timestamps do not map to an exact frame count, so the presenter would drift out of sync with the audio. Adding `-frames:v 221` gives exactly 221 frames and every frame shows the intended mouth state (verified frame by frame against the sprites).

## Files
- `backend/src/media/ffmpeg.ts` (only `presenterClipArgs` and its doc comment)
- `backend/test/presenter.test.ts`

## Changes
`presenterClipArgs` gets a REQUIRED `frames: number` (positive integer, else throw a clear Error) and appends `'-frames:v', String(frames)` right before the output path:
`['-f','concat','-safe','0','-i', listFile, '-vf', `fps=${fps},format=argb`, '-c:v','qtrle', '-frames:v', String(frames), out]`.
Update the doc comment: callers pass `states.length`; without it the clip length is not frame-exact.

## Tests (write first, must fail first)
- Update the existing exact-args test for the new argument; add: `frames: 221` appears as `-frames:v 221` just before `out`; custom fps still shows in `-vf`.
- Throws for `frames` 0, -3, 1.5 and NaN.

## Acceptance
- `cd backend && node --test --import tsx test/presenter.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
Any other builder or file.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
