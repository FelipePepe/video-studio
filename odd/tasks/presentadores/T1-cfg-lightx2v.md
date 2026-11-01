# T1 — cfg 1 when lightx2v is enabled

## Goal
The lightx2v 4-step LoRAs are distilled for cfg 1. Today `samplerInputs` in `buildTail` always uses `DEFAULTS.cfg` (6.0), which burns color/contrast. Make cfg 1 the value whenever `useLightx2v` is true, and make cfg overridable.

## Files
- `backend/src/comfy/workflows.ts`
- `backend/test/workflows.test.ts`

## Changes
1. Add `cfg?: number` to `CommonOptions` (with a one-line doc comment).
2. In `buildTail`'s `samplerInputs`, use `o.cfg ?? DEFAULTS.cfg` instead of `DEFAULTS.cfg`.
3. In `withLightx2v(o)`, also set `cfg: o.cfg ?? 1` (same pattern as steps/switchStep).

## Tests (write first, must fail first)
In `workflows.test.ts` (helpers `samplerPair`, `byType` already exist):
- With `useLightx2v: true` (T2V and I2V), BOTH WanVideoSampler nodes have `inputs.cfg === 1`.
- Without lightx2v, both have `cfg === 6` (DEFAULTS.cfg).
- An explicit `cfg: 3` wins in both modes.

## Acceptance
- `node --test --import tsx test/workflows.test.ts` all green; existing test at ~line 139 (`cfg 6.0`) still passes.
- `pnpm typecheck` green.

## Do NOT touch
Any other file, the DEFAULTS values, the music workflow's KSampler cfg.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Run tests only with: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.

