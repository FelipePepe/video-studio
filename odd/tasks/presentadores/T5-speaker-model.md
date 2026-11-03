# T5 — `speaker` on Scene (backend + frontend types)

## Goal
Two presenters (A and B) will talk in dialogue. Each scene needs to say who speaks. Add an optional, backwards-compatible field. No DB migration: the escaleta is stored as JSON in `drafts.escaleta`.

## Files
- `backend/src/pipeline/types.ts`
- `frontend/src/api/types.ts`
- `backend/test/draftRepository.test.ts`

## Changes
1. Add `export type Speaker = 'A' | 'B';` and `speaker?: Speaker;` (doc comment: presenter who delivers the line; A uses voiceA, B uses voiceB; absent = legacy narration) to `Scene` in `backend/src/pipeline/types.ts`.
2. Mirror both in `frontend/src/api/types.ts` (`Speaker` + `Scene.speaker?`).

## Tests (write first, must fail first)
In `draftRepository.test.ts` add a test: create a draft whose escaleta has scenes with `speaker: 'A'` / `'B'` and one scene without it, read it back with `getDraft`, and assert the speakers round-trip unchanged and the speakerless scene has no `speaker` key. (It will fail typecheck first because `speaker` is not in `Scene`; run `pnpm typecheck` to see the RED.)

## Acceptance
- `draftRepository.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
draft.ts, routes, repository code, frontend components.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Frontend tests: `cd frontend && pnpm vitest run test/<file>.test.tsx`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
