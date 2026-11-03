# T7 — expose dialogue format in the API

## Goal
`POST /api/pipeline/draft` already forwards the whole JSON body to `generateDraft` (which validates `format`/`hosts` after T6), and `PUT /draft/:id/segments` already uses `validateEscaleta` with `keepVoices`. Lock this behaviour in with route tests and fix anything that does not work end-to-end.

## Files
- `backend/test/pipeline.routes.test.ts`
- `backend/src/routes/pipeline.ts` (only if a test proves it is needed — expected: no change)

## Tests (write first)
Follow the existing helpers/fakes in `pipeline.routes.test.ts`:
- `POST /draft` with `{ text, format: 'dialogue', hosts: { a: 'Ana', b: 'Leo' } }` and a fake Ollama returning scenes with alternating speakers → 201, response escaleta keeps `speaker` and voices match voiceA/voiceB.
- `POST /draft` with `format: 'podcast'` → 400.
- `POST /draft` with `format: 'dialogue'` and a reply lacking speaker → 502 (invalid model output is an upstream failure, as today).
- `PUT /draft/:id/segments` with scenes carrying `speaker` → 200 and `GET /draft/:id` returns the same speakers; with `speaker: 'C'` → 400.

## Acceptance
- `pipeline.routes.test.ts` green; `pnpm typecheck` green. If all new tests pass without touching `routes/pipeline.ts`, that is the correct outcome: say so in the report.

## Do NOT touch
draft.ts, types.ts, frontend, approve options.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Frontend tests: `cd frontend && pnpm vitest run test/<file>.test.tsx`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
