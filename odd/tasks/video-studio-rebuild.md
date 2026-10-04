# video-studio-rebuild

**Status:** in progress · **Created:** 2026-10-04
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/` · **Chain root branch:** `feature/video-studio-rebuild`
**Engram mirror:** `odd/video-studio-rebuild/tasks`

## Objective
Recreate the lost `video-studio` project from the Atlas note `Proyectos/video-studio` (plus `Stack/AI-ML/ComfyUI`): article (URL or text) → Ollama escaleta → human review → Kokoro TTS → ComfyUI Wan2.2 T2V/I2V → ffmpeg final video.

## Problem / why
The original repo (`/home/sandman/sources/video-studio/`) is not on maya, spark, GitHub `FelipePepe` or org `felipepepe-ai-labs`. Only the Atlas note survives.

## Scope
Everything in the note, in phases. Out of scope: `visual-character-sync` (no spec; open item).

## Constraints
- Node 22.22 on maya; `node:sqlite` built-in; backend CommonJS; tests with `node:test` (backend) and Vitest (frontend).
- No `.env` files with secrets (Infisical). Never build after changes (user rule).
- Conventional commits, no AI attribution. Commits only on feature branches (lefthook).
- Wan2.2 rules: VAE `wan_2.1_vae.safetensors` bf16 never changes; omit `end_image` key when absent; `save_output: true`.

## Process config
- **TDD:** ON — source: explicit user choice (2026-10-04). Runners: backend `node --test --import tsx`; frontend `vitest run`.
- **Delivery strategy:** `feature-branch-chain` (explicit user choice). One PR per phase, chained; final PR → `develop`. PRs are never merged by the agent.
- **Authorized scope:** write files under the repo path; git branches/commits in this repo; `gh pr create` per phase. Remote execution (spark: ComfyUI jobs) needs separate authorization.
- **Forecast:** ~3,500–4,500 authored changed lines across 5 PRs (excluding lockfiles).

## Tasks
- [x] T0 Bootstrap: git, main/develop, feature branch, pnpm monorepo, lefthook, README — route: inline (mechanical config files; no delegation trigger fired). Commit `a0c05bd` (`chore: bootstrap pnpm monorepo with lefthook`). Evidence: `pnpm install` ok, lefthook hooks installed (`.git/hooks/pre-commit`), commit passed branch-protection and gitleaks on `feature/video-studio-rebuild`. Not TDD-applicable (config only).
- [x] T1 Backend foundation: node:sqlite connection + schema, server settings, buildApp with lazy clients, GET/PATCH /api/config — route: delegated writer (trigger: 2+ non-trivial files; model sonnet). TDD ON, runner `node --test --import tsx`. RED observed in 2 units (`Cannot find module '../src/db/connection'`, `'../src/app'`), GREEN afterwards. Parent re-verified: `pnpm --filter @video-studio/backend test` → 16 pass / 0 fail; `typecheck` clean. 322 authored lines in `backend/` (lockfile excluded). Notes: `schema.sql` is read via `__dirname` (a future emitting build must copy it); no `jobs` table yet (comes in T3c).
- [x] T1b (route: delegated writer, sonnet; TDD ON — RED observed for units 1–3 on assertions / module-not-found, unit 4 characterizes existing behavior so no RED was invented; parent re-verified 34 pass / 0 fail, typecheck clean; ~146 authored lines) Harden config API from advisory review findings: PATCH rejects requests with no recognized host keys (400) instead of silent 200; JSON `{ error }` handler for malformed bodies; validate `PORT`/`DB_PATH` in `server.ts`; test file-backed DB reopen. Added because the WARNING shows a real silent-success path; the two SUGGESTIONs ride along as they touch the same files.
- [x] T2a ComfyUI client (submit, poll, upload, download) — `c1c7248`. Delegated writer (sonnet), TDD RED = module not found → GREEN. ~334 lines.
- [x] T2b (`14c9cbb` Ollama, `3869171` Piper + rename; ~142 + ~337 lines; RED on module-not-found and 8 assertion failures for the rename) Ollama + Piper clients, and rename `kokoroHost` → `piperHost` across the T1 config API. Changed 2026-10-04 by the user ("kokoro no lo usamos ahora, usamos piper"): the Atlas note's Kokoro (`:8880`, HTTP) is obsolete. Evidence: Piper runs on spark as Docker `rhasspy/wyoming-piper` on `:10200` (Atlas `Setup/Spark-IA.md`), speaking the Wyoming TCP protocol; sibling `video-transcriptor` uses Spanish voices `es_ES-davefx-medium` (male) and `es_ES-sharvard-medium` speaker 1 (female). Client built against a fake Wyoming server; real-server verification pending (needs user authorization to contact spark).
- [x] T2c ffmpeg assembly helpers (Ken Burns, xfade, concat, mux) — `02d37bc`, ~250 lines; integration test ran with the local ffmpeg.
- [x] T2d Wan2.2 T2V/I2V workflow builders — `1ce8b3b`, ~331 lines; tests encode VAE bf16 `wan_2.1_vae`, `end_image` omission, `save_output`, no `WanVideoSamplerv2`. Default negative prompt is the writer's choice (`blurry, low quality, distorted, watermark, text, static, deformed`).
- [x] T2-fix Review correction `68c3320`: migrate `kokoro_host` → `piper_host` on existing DBs (RED: assertion on missing `piper_host`; GREEN 96/96).
- [ ] T2e Hardening from phase-2 advisory findings (non-blocking): ComfyUI poll tolerates transient fetch errors and bounds each request (`R4-comfy-poll-no-transient-tolerance`, `R3-comfy-wait-unbounded-request`); Piper guards malformed frame parsing and de-duplicates host parsing (`R3-piper-unguarded-frame-parse`, `R2-dup-piper-host-parse`); make the settings migration atomic (`R4-migration-not-atomic`); document why `pingpong`/the no-op LoRA node exist (note-mandated). Remaining SUGGESTIONs deferred.
- [ ] T3a Draft generation (article fetch → Ollama → validated escaleta)
- [ ] T3b Approval orchestrator with SSE
- [ ] T3c Job management endpoints
- [ ] T4a Frontend scaffold, API client, settings modal, sidebar
- [ ] T4b Pipeline form, progress stages, video panel
- [ ] T4c Escaleta cards and SegmentEditor review mode
- [ ] T5a PipelineAgent (Claude tool use, unconnected to orchestrator)
- [ ] T5b README/setup docs and Atlas note update

## Acceptance criteria
- `pnpm -r test` green; `pnpm -r typecheck` clean.
- Workflow-builder tests encode the VAE and parameter rules from the note.
- Draft → review → approve flow works end to end with fake clients; real-host run only with user authorization.

## Progress
- 2026-10-04: plan approved. T0 done (`a0c05bd`). Running slice count: 271 authored lines (incl. this doc).

## Verification evidence
_(none yet)_

## Review assessments per task
Last reviewed boundary: `68c3320` (end of PR slice 2).
- T0 (`a0c05bd`): risk medium (`executable_change`: `.npmrc`), `review_due: false`, reason `under_budget` (271 lines). Pending in the slice until T1.
- T1 (`78668eb`): range `635c61e..78668eb`, risk medium, `review_due: true` (`slice_budget_reached`; 1791 lines counted, 1163 of them the generated lockfile). Consent granted by the user; one lens (`review-reliability`) → **approved**, acknowledged, authority burned (lineage `review-f093030dc3f776be`). Three non-blocking advisory findings (see T1b).

- T1b (`9d69315`): range `78668eb..9d69315`, 168 lines, medium, `review_due: false` (`under_budget`); folded into the phase-2 range.
- Phase 2 (`c1c7248..68c3320`): range `9d69315..HEAD`, high (`process_boundary` in `ffmpeg.ts`), `review_due: true` (`high_risk`). User granted consent; 4 lenses → `correction_required` (CRITICAL: `kokoro_host` rename without migration, found by reliability + resilience). One bounded correction (`68c3320`, ~51 lines of 200 budget). Native flow then required a maintainer recovery authorization (`scope_changed`); the user authorized it; `gentle-ai review recover` derived the binding and created successor `review-babf1faa9cb4fed2-r1`; 4 lenses → **approved**, acknowledged, authority burned. 13 advisory findings (→ T2e).

## Slices (PRs)
Branch chain (local): `develop` ← `feature/video-studio-rebuild` (root, `a0c05bd` bootstrap) ← `feature/video-studio-rebuild-p1` (T1, T1b) ← `-p2` (T2a–d) ← `-p3` (T3a–c) ← `-p4` (T4a–c) ← `-p5` (T5a–b).
No git remote exists yet, so no PR has been opened. Pushing and creating the GitHub repo needs the user's explicit authorization (destination, repo name, visibility).

## Open items
- No git remote: PRs cannot be opened until the user authorizes creating/pushing a GitHub repo.
- `visual-character-sync` has no spec.
- TTS is Piper (Wyoming, `tcp://192.168.1.60:10200` default), not Kokoro as the Atlas note says; the Atlas note must be corrected in T5b.
- Wyoming protocol verified against real spark (2026-10-04, user-authorized, read-only probe `describe` + one 1.6 s synthesis at `192.168.1.60:10200`): events carry data via `data_length` (not inline), `audio-start` → ~36 `audio-chunk` → `audio-stop`, 22050 Hz 16-bit mono, 163 voices incl. `es_ES-davefx-medium` and `es_ES-sharvard-medium` (speakers `M`,`F`; index 1 accepted). The PiperClient itself is still tested only against a local fake server that mirrors these facts; running the client end to end against spark needs a further check.
- PR #1 (`p1` → `feature/video-studio-rebuild`) is open: https://github.com/FelipePepe/video-studio/pull/1 (repo `FelipePepe/video-studio`, private, created 2026-10-04 at the user's request).

## Next step
T1b (hardening, delegated writer), then phase 2 (T2a–d).

User goal (2026-10-04): "implementa todas las fases" — continue through all phases without stopping between tasks, pausing only for real decisions/authorizations (remote repo, real-host runs on spark).
