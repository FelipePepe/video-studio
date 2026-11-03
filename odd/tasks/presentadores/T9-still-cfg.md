# T9 — lightx2v: cfg 3 for 1-frame T2V stills (keep cfg 1 for I2V and video T2V)

## Evidence (real renders on the Spark, same seed/prompt, 2026-10-31)
- 1-frame T2V stills with lightx2v: cfg 1 (any high/low split 3/1, 2/2, 1/3) and cfg 2 come out hazy/blurred; cfg 3, 4 and 6 are sharp. cfg 3 is the cleanest and least saturated.
- I2V transitions with lightx2v (same start/end stills): cfg 1 is clean and coherent, cfg 3 is oversaturated, cfg 6 is completely burnt.
So commit ca9a9e0 (cfg 1 for every lightx2v workflow) is right for I2V but breaks the stills.

## Goal
With `useLightx2v`, default cfg is 3 for a T2V workflow that generates a single frame (`numFrames === 1`, the still path), and stays 1 for every other lightx2v workflow (I2V, multi-frame T2V). An explicit `cfg` option still wins. Invalidate cached stills/transitions rendered with the previous settings.

## Files
- `backend/src/comfy/workflows.ts`
- `backend/src/pipeline/contentCache.ts` (only `WORKFLOW_VERSION`)
- `backend/test/workflows.test.ts`

## Changes
1. `workflows.ts`: add `export const LIGHTX2V_STILL_CFG = 3;` with a doc comment citing the evidence above (short). Give `withLightx2v` a second parameter `defaultCfg = 1` and use `cfg: o.cfg ?? defaultCfg`. In `buildT2VWorkflow` call `withLightx2v(o, (o.numFrames ?? DEFAULTS.numFrames) === 1 ? LIGHTX2V_STILL_CFG : 1)`. Leave `buildI2VWorkflow` as is. Update the comment above `withLightx2v` (the "cfg > 1 burns color" claim is only true for I2V/video).
2. `contentCache.ts`: bump `WORKFLOW_VERSION` from 2 to 3 (comment: lightx2v still cfg changed, old stills/transitions are stale).

## Tests (write first, must fail first)
In `workflows.test.ts`, extend the lightx2v cfg test (do not remove existing assertions):
- `buildT2VWorkflow({ prompt, seed, useLightx2v: true, numFrames: 1 })` → both experts cfg `LIGHTX2V_STILL_CFG` (3).
- `buildT2VWorkflow({ ..., useLightx2v: true })` with the default frame count → cfg 1 (existing).
- `buildT2VWorkflow({ ..., useLightx2v: true, numFrames: 1, cfg: 2 })` → cfg 2 (explicit wins).
- `buildT2VWorkflow({ ..., numFrames: 1 })` without lightx2v → `DEFAULTS.cfg`.
- I2V with lightx2v → cfg 1 (existing).

## Acceptance
- `node --test --import tsx test/workflows.test.ts` and `test/orchestrator.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
orchestrator.ts, other builders, steps/switchStep/shift values, frontend.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
