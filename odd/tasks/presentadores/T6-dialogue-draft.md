# T6 — dialogue format in draft generation

## Goal
`generateDraft` can produce a conversation between two presenters instead of a single narration. The LLM decides who speaks (`speaker` A/B); the voice is derived deterministically from `speaker` (never trusted from LLM text).

## Files
- `backend/src/pipeline/draft.ts`
- `backend/test/draft.test.ts`

## Changes
1. `DraftInput`: add `format?: 'narration' | 'dialogue'` (default `'narration'`) and `hosts?: { a: string; b: string }` (presenter names, each non-empty trimmed string ≤ 40 chars; default `{ a: 'Ana', b: 'Leo' }`). Invalid values throw `DraftInputError` (follow the style of `optionalString` / the `mix` check): `format` not one of the two, `hosts` not an object with string `a` and `b`.
2. `systemPrompt(language, format, hosts)`: keep the current prompt for `narration` unchanged (existing tests rely on it). For `dialogue`: the JSON shape becomes `{ "scenes": [ { "title", "narration", "visualPrompt", "speaker": "A"|"B" } ] }`; instruct that the scenes are a lively conversation between presenter A (<hosts.a>) and presenter B (<hosts.b>) explaining the article, each scene is ONE intervention of ONE presenter, they alternate naturally, "narration" is what that presenter says aloud (plain sentences, no markdown, no stage directions, no name prefixes), and "visualPrompt" is an English prompt for the explanatory B-roll background shot illustrating what is being said (no presenters, no text overlays).
3. `validateEscaleta`: if a scene has `speaker`, it must be `'A'` or `'B'` (else `DraftValidationError`); keep it on the output scene. Voice resolution order: (a) `keepVoices && s.voice !== undefined` → that voice (unchanged behaviour); (b) else if `speaker` present → `speaker === 'A' ? rules.voiceA : rules.voiceB`; (c) else the current mix logic. Scenes without `speaker` must produce objects with NO `speaker` key (existing deepEqual tests).
4. In dialogue format, `generateDraft` must reject a model reply where any scene lacks `speaker` (`DraftValidationError('scene N must have a speaker')`) — add an optional `requireSpeaker?: boolean` to `VoiceRules` for this, set from `format === 'dialogue'`.
5. `GeneratedDraft` stays unchanged (format/hosts are not persisted).

## Tests (write first, must fail first) — use the fake Ollama already used in draft.test.ts
- narration (default): system prompt does not mention speaker; output scenes have no `speaker` key.
- dialogue: the system prompt passed to the fake contains both host names and `"speaker"`; scenes alternating A/B come back with `speaker` kept and `voice` = voiceA for A, voiceB for B (use voiceA 'male', voiceB 'female'); `mix` is ignored for scenes with speaker.
- dialogue with a scene missing speaker → rejects with DraftValidationError.
- invalid speaker value ('C') → DraftValidationError (via validateEscaleta directly).
- `keepVoices` with explicit `voice` wins over speaker-derived voice.
- invalid `format` and invalid `hosts` → DraftInputError.

## Acceptance
- `draft.test.ts` green (all pre-existing tests untouched and green); `pnpm typecheck` green.

## Do NOT touch
routes, types.ts (T5 already added `speaker`), frontend.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Frontend tests: `cd frontend && pnpm vitest run test/<file>.test.tsx`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
