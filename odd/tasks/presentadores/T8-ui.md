# T8 — UI: dialogue switch and per-scene speaker

## Goal
The human can request a dialogue draft, name the presenters, and correct who speaks each scene during review.

## Files
- `frontend/src/api/types.ts` (`DraftRequest`: add `format?: 'narration' | 'dialogue'` and `hosts?: { a: string; b: string }`)
- `frontend/src/components/PipelineForm.tsx`
- `frontend/src/components/SegmentEditor.tsx`
- `frontend/src/i18n.tsx`
- `frontend/test/PipelineForm.test.tsx`
- `frontend/test/SegmentEditor.test.tsx`

## Changes
1. `PipelineForm`: a segmented toggle (same `segmented` pattern as the source toggle, `aria-pressed`) "Narration / Dialogue", default narration. When dialogue is selected show two text inputs for the presenter names (defaults `Ana`, `Leo`, max 40 chars). `onSubmit` includes `format: 'dialogue', hosts: { a, b }` only in dialogue mode; in narration mode the request is exactly what it is today (no new keys).
2. `SegmentEditor`: when a scene has `speaker` (or any scene in the list has one), show a per-scene select "Speaker" with options A / B. Changing it calls `update(index, { speaker, voice })` where voice is `speaker === 'A' ? voiceA : voiceB`. The editor does not know voiceA/voiceB today: add an optional prop `speakerVoices?: { A: string; B: string }` (default `{ A: 'male', B: 'female' }`) and use it. Scenes in a dialogue draft must keep `speaker` through move/delete (they already spread the scene). `addBelow` creates the new scene with the same `speaker` as the scene above, flipped (A↔B) when that scene has a speaker; check `emptyScene` in `frontend/src/lib/escaleta.ts` — if it needs a change to accept a speaker, report it instead of editing (not in Files); use `{ ...emptyScene(voice), speaker }` inline in the component instead.
3. `i18n.tsx`: add ES and EN keys (`form.format`, `form.format.narration`, `form.format.dialogue`, `form.hostA`, `form.hostB`, `editor.speaker`) following the existing key style; the i18n test enforces ES/EN parity.

## Tests (write first, must fail first)
- PipelineForm: default submit has no `format`/`hosts` keys; after clicking Dialogue and editing the names, submit includes `format: 'dialogue'` and the names; host inputs are hidden in narration mode.
- SegmentEditor: with scenes carrying `speaker`, the speaker select is shown; changing scene 2 from B to A calls `onChange` with that scene `speaker: 'A'` and `voice` = A's voice (test `speakerVoices` too); scenes without any speaker show no speaker select.

## Acceptance
- `PipelineForm.test.tsx`, `SegmentEditor.test.tsx`, `i18n.test.tsx` green; full `pnpm test` in `frontend`; `pnpm typecheck` green.

## Do NOT touch
Backend, usePipeline, ReviewPanel, styles.css (reuse existing classes).

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Frontend tests: `cd frontend && pnpm vitest run test/<file>.test.tsx`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
