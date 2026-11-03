# T12 — overlay both presenters on the video (pure ffmpeg arg builder)

## Goal
Two presenter clips with alpha (from T11, `.mov` qtrle, both as long as the whole video, mouths closed while the other one talks) are composited over the background video: presenter A bottom-left, presenter B bottom-right. One x264 pass, audio untouched. No ffmpeg run in the tests.

## Files
- `backend/src/media/ffmpeg.ts` (append only)
- `backend/test/presenter.test.ts` (append tests)

## API (exact)
```ts
export interface PresenterOverlayOptions {
  video: string;            // background video (already without presenters)
  clipA: string;            // .mov with alpha
  clipB: string;            // .mov with alpha
  out: string;
  videoHeight: number;      // output height in px of `video` (e.g. 720, or 1280 for the vertical variant); positive integer
  heightRatio?: number;     // presenter height as a fraction of videoHeight. default 0.4, must be in (0.1, 0.9]
  marginRatio?: number;     // margin to the edges as a fraction of videoHeight. default 0.02, must be in [0, 0.2]
}
export function presenterOverlayArgs(o: PresenterOverlayOptions): string[];
```

## Behaviour
`H = 2 * Math.round(videoHeight * heightRatio / 2)` (even), `M = Math.round(videoHeight * marginRatio)`.
Filter (no spaces/newlines in the real string):
```
[1:v]scale=-2:H[a];
[2:v]scale=-2:H[b];
[0:v][a]overlay=x=M:y=main_h-overlay_h-M:eof_action=pass:format=auto[t];
[t][b]overlay=x=main_w-overlay_w-M:y=main_h-overlay_h-M:eof_action=pass:format=auto[v]
```
Args: `['-i', video, '-i', clipA, '-i', clipB, '-filter_complex', filter, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(VIDEO_CRF), '-pix_fmt', 'yuv420p', '-c:a', 'copy', out]`.
Throw clear Errors for invalid `videoHeight` (not a positive integer), `heightRatio`, `marginRatio`.

## Tests (write first, must fail first)
- Defaults for `videoHeight: 720`: `H = 288`, `M = 14` appear in the filter; A overlay starts at `x=14`, B overlay uses `main_w-overlay_w-14`; exactly one `libx264`; `-crf` equals `String(VIDEO_CRF)`; `-map 0:a?` and `-c:a copy` present; inputs in order video, clipA, clipB.
- `videoHeight: 1280` with `heightRatio: 0.3`, `marginRatio: 0` -> `H = 384`, `M = 0`.
- Odd result is rounded to even (e.g. `videoHeight: 500, heightRatio: 0.35` -> 175 -> 174 or 176 per `2*Math.round(x/2)`).
- Throws for `videoHeight` 0 / 720.5, `heightRatio` 0.05 / 1, `marginRatio` -0.1 / 0.5.

## Acceptance
- `cd backend && node --test --import tsx test/presenter.test.ts` green; `test/ffmpeg.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
Existing builders, audioEnvelope.ts, orchestrator, routes, frontend.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
