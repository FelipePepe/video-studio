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
- [ ] C1 generator comparison on the Spark (Flux vs Qwen-Image vs current)
- [ ] C2 integrate the chosen generator (+ tests)

## Rules
TDD on, runners: backend `node --test --import tsx test/<file>.test.ts`; full suite `cd backend && pnpm test`; `pnpm typecheck` at the root. Delegated writers per task; no git commands for writers; parent commits per task. Push/PR only with user OK. ~400 changed lines is advisory.

## Progress
(see checklist; evidence below as tasks close)
