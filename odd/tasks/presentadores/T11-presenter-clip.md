# T11 — presenter sprites and mouth-animated clip (pure ffmpeg arg builders)

## Goal
A presenter is ONE character image (a felt-puppet character on a flat green background). The mouth is animated by dropping the lower jaw: the image is split at a mouth line, the bottom part moves down by a small amount depending on the mouth state (`closed`/`mid`/`open`), and a darkened copy of the image shows through the gap as the inside of the mouth. Green is keyed out to alpha. Build the pure ffmpeg argument builders for (1) one sprite per state and (2) a full-length clip with alpha from a mouth-state timeline. No ffmpeg is run in the tests.

## Files
- `backend/src/media/ffmpeg.ts` (append only; reuse `num`, `buildConcatList`'s quoting rule, `VIDEO_CRF` is NOT used here)
- `backend/test/presenter.test.ts` (new)

## API (exact)
```ts
import type { MouthState } from './audioEnvelope';

export interface PresenterSpriteOptions {
  image: string;
  out: string;               // .png
  state: MouthState;
  mouthY?: number;           // where the jaw splits, fraction of the image height. default 0.55, must be in [0.1, 0.9]
  drop?: number;             // max jaw drop as a fraction of the image height. default 0.06, must be in (0, 0.3]
  keyColor?: string;         // default '0x00FF00'
  keySimilarity?: number;    // default 0.28
  keyBlend?: number;         // default 0.08
}
export function presenterSpriteArgs(o: PresenterSpriteOptions): string[];

/** concat-demuxer script: one `file`/`duration` pair per RUN of equal states (merge consecutive equal states). */
export function presenterConcatList(states: MouthState[], sprites: Record<MouthState, string>, fps?: number): string;

export function presenterClipArgs(o: { listFile: string; out: string; fps?: number }): string[];  // .mov with alpha
```

## presenterSpriteArgs — the filter is already validated with real ffmpeg, use it verbatim
With `MY = num(mouthY)`, `DROP = num(drop)`, `S = 0 | 0.5 | 1` for closed | mid | open (use `num(S)`):
```
[0:v]format=rgba,chromakey=${keyColor}:${keySimilarity}:${keyBlend},split=4[c][d][a][b];
[c]colorchannelmixer=aa=0,pad=iw:ceil(ih*(1+DROP)):0:0:color=0x00000000[canvas];
[d]lutrgb=r=val*0.25:g=val*0.2:b=val*0.2[dark];
[a]crop=iw:floor(ih*MY):0:0[top];
[b]crop=iw:ih-floor(ih*MY):0:floor(ih*MY)[bot];
[canvas][dark]overlay=0:0:format=auto[c0];
[c0][top]overlay=0:0:format=auto[c1];
[c1][bot]overlay=0:floor(main_h/(1+DROP)*MY)+round(main_h/(1+DROP)*DROP*S):format=auto
```
(joined with no spaces/newlines in the real string). Args: `['-i', image, '-filter_complex', filter, '-frames:v', '1', out]`. Throw clear Errors for invalid `mouthY`/`drop` and for an unknown `state`.

## presenterConcatList
`fps` default 24. Merge consecutive equal states into one entry with `duration = run / fps` (use `num`). Quote paths exactly like `buildConcatList` does (`'` -> `'\''`). The concat demuxer ignores the duration of the last entry, so repeat the last `file` line once at the end (standard workaround). Throw on an empty `states` array.

## presenterClipArgs
`['-f','concat','-safe','0','-i', listFile, '-vf', `fps=${fps},format=argb`, '-c:v','qtrle', out]` with `fps` default 24 (qtrle in a .mov keeps the alpha channel; a long static run is tiny).

## Tests (write first, must fail first)
- `presenterSpriteArgs`: for each state the filter contains `chromakey=0x00FF00:0.28:0.08`, `split=4`, `lutrgb=`, and the final overlay y-expression with `*0` / `*0.5` / `*1` for closed / mid / open; defaults and overrides of `mouthY`/`drop`/`keyColor`; args start with `-i image` and end with `-frames:v 1 out`; throws for `mouthY` 0.05 / 0.95, `drop` 0 / 0.5, bad state.
- `presenterConcatList`: `['closed','closed','open','open','open','mid']` at 24 fps -> 3 entries with durations `0.083333`, `0.125`, `0.041667` (as produced by `num`) and the last file repeated; a path with a quote is escaped; empty array throws.
- `presenterClipArgs`: exact deepEqual for defaults, and a custom fps appears in the `-vf`.

## Acceptance
- `cd backend && node --test --import tsx test/presenter.test.ts` green; `test/ffmpeg.test.ts` still green; `pnpm typecheck` green.

## Do NOT touch
Existing builders in ffmpeg.ts, audioEnvelope.ts, orchestrator, routes, frontend.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
