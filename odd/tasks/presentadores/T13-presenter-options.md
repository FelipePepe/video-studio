# T13 — approve option `presenters` (character ids, mode volume)

## Goal
The approve endpoint accepts which two characters present the video. Options carry character IDS (not file paths): the server resolves the images from its own character store (built in a later task), so no path confinement is needed. Only `mode: 'volume'` (mouth driven by the audio volume) exists for now; `lipsync` is a later mode and must be rejected with a clear message.

## Files
- `backend/src/pipeline/types.ts`
- `backend/src/routes/pipeline.ts` (only `parseApproveOptions`)
- the existing test file that covers `parseApproveOptions` / the approve route options — find it with `grep -ln "Unknown approve option\|useLightx2v" backend/test/*.ts` (probably `pipeline.routes.test.ts` or `approve.routes.test.ts`); add the tests there.

## Changes
1. `types.ts`:
```ts
export type PresenterMode = 'volume';
/** The two on-screen presenters. `a` and `b` are character ids from the character store. */
export interface PresenterOptions { mode: PresenterMode; a: string; b: string; }
```
and `presenters?: PresenterOptions;` on `ApproveOptions` (doc comment: speaker A uses character `a`, speaker B uses `b`).
2. `parseApproveOptions`: add `'presenters'` to the strict key allowlist. Validation for `o.presenters` (throw `ApproveOptionsError` with these messages):
   - must be a plain object (not array/null): `presenters must be an object`;
   - only the keys `mode`, `a`, `b` are allowed: `Unknown presenters option: <key>`;
   - `mode` must be the string `'volume'`; if it is `'lipsync'` the message is `presenters.mode "lipsync" is not available yet`; anything else: `presenters.mode must be "volume"`;
   - `a` and `b` are required strings matching `/^[A-Za-z0-9_-]{1,64}$/`: `presenters.a must be a character id` (same for b);
   - `a !== b`: `presenters a and b must be different characters`.
   Store the validated object on `opts.presenters` (copy only the three known fields).

## Tests (write first, must fail first)
Through the approve route (use the same helpers as the neighbouring option tests, 202 JSON response style): valid `{ presenters: { mode: 'volume', a: 'ana', b: 'leo' } }` -> accepted and the job options contain it; each error case above -> 400 with the exact message; an unknown top-level option is still rejected; existing option tests unchanged.

## Acceptance
- the touched test file green, `pnpm typecheck` green.

## Do NOT touch
orchestrator, runner, frontend, other options.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
