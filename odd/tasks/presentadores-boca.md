# Presenters: real mouth + better characters (A and C)

## Objective
Replace the "jaw split" mouth (cuts the whole character in two at a fixed height, `presenterSpriteArgs`) with a mouth that changes only the lip area, and generate sharper characters. User-approved 2026-11-01 ("hagamos A y C, empezando por A"). Branch `feature/presentadores-boca`, stacked on `feature/presentadores-fase3-4` (PR #77 open).

## Problem (verified in code and frames)
- `presenterSpriteArgs` splits the image at `mouthY` (default 0.55, never measured, stored NULL) and moves the lower half down: a dark bar across the whole face.
- Characters come from 1-frame Wan T2V: blurry, low detail.

## Design A (mouth as its own piece)
- Detect the lips per character at analysis time: largest connected region of deep-red pixels (nose, hair and eyes must not win). Store `mouth: {x,y,w,h}` in FULL-image px (characters table, new nullable column, migration v5).
- New sprite builder: closed = original keyed image; mid/open = same image with a dark mouth interior ellipse (and a tongue when open) drawn INSIDE the lip box, leaving a red rim. Same canvas size for all states (no pad) so the clip/concat code stays untouched.
- `presenterAssets` returns `mouth`; the orchestrator passes it to the sprite builder (fallback to the old jaw sprite when `mouth` is null, so old characters keep working).
- `POST /api/characters/:id/reanalyze` recomputes keyColor/crop/mouth from the stored image (backfills Ana and Leo).

## Design C (better characters)
- Evaluate Flux (`flux_dev.safetensors`, 23.8 GB, in diffusion_models) / Qwen-Image on the Spark with a felt-puppet prompt on green; `flux1-dev.safetensors` fails to load (truncated file). Pick the best, then add a generator + workflow builder and use it for new characters.

## Tasks
- [x] A1 mouth detection in `characterAnalysis.ts` (+ test) — 32 tests; real boxes: Ana {346,491,340,174}, Leo {329,439,386,162} (bright red OR dark maroon mask)
- [x] A3 mouth sprite builder `presenterMouthSpriteArgs` in `media/ffmpeg.ts` (+ test) — real-ffmpeg sheet looked right (closed/mid/open inside the lips)
- [x] A2 migration v5 + repository + presenterAssets + reanalyze route (+ tests) — column `mouth` (fresh + migrated paths), `updateAnalysis`, `POST /:id/reanalyze` (422 on failure), create passes `runFfmpegRaw`; RED seen first (9 failing assertions across 4 files)
- [x] A4 orchestrator wiring (+ test) — `executePresenters` uses `presenterMouthSpriteArgs` when `assets.mouth` is set, jaw path otherwise; tests cover with/without/mixed
- [ ] A5 real check on Ana and Leo (backfill, sprites, one rendered clip, frame check)
- [x] C1 generator comparison on the Spark: Qwen-Image chosen (98 s, sharp, flat green bg); Flux dev 60 s but full-body with gradient bg and floor shadow; current Wan still blurry
- [x] C2 integrate the chosen generator (+ tests)
- [x] C4 prompt: positive no-green sweater instruction + stronger uniform-backdrop wording + extra negatives (+ tests); real check on Mara seeds 7/11: sweater purple/mustard, no green on the character; seed 11 backdrop uniform, seed 7 still has a slightly lighter band at the very bottom
- [x] C3 mouth detector robust for thin smiles in `characterAnalysis.ts` (+ tests) — crimson test (b >= 0.8 g) in both clauses, shape-based `selectMouthBlob` (wide beats round), `normalizeMouthBox` (h >= 0.4 w), min blob 0.2 %; real boxes: Ana {351,491,326,170}, Leo {329,439,386,162}, Mara {410,533,228,91}, Teo {393,557,258,103}
- [x] C5 green fringe after the chroma key: `EDGE_CLEAN` in `media/ffmpeg.ts` (despill mix 0.5 + 2x alpha erosion + alpha lut) right after the chromakey in both sprite builders; checked by eye on Mara/Teo/Ana/Leo over #3a1a4a

## Rules
TDD on, runners: backend `node --test --import tsx test/<file>.test.ts`; full suite `cd backend && pnpm test`; `pnpm typecheck` at the root. Delegated writers per task; no git commands for writers; parent commits per task. Push/PR only with user OK. ~400 changed lines is advisory.

## Progress
- A5 real check (2026-11-01, job cb1bab8b, 2 scenes, fast mode default, mouths backfilled via `POST /reanalyze`): 8.7 s, 0 warnings; mouths open INSIDE the lips, nothing is cut. It exposed a pre-existing intermittent bug: the presenter overlay lost the presenters for 2-10 frames around the cut between clips (framesync race; 12 of 30 identical real runs). Fix: `setpts=PTS-STARTPTS` on all three overlay inputs = 0 of 30 runs with holes. Tests updated (presenter.test.ts, orchestrator.presenters.test.ts).
