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
- [x] T2e (`ceaf96c`, ~205 lines; delegated writer, TDD RED on assertions/module-not-found) Hardening from phase-2 advisory findings (non-blocking): ComfyUI poll tolerates transient fetch errors and bounds each request (`R4-comfy-poll-no-transient-tolerance`, `R3-comfy-wait-unbounded-request`); Piper guards malformed frame parsing and de-duplicates host parsing (`R3-piper-unguarded-frame-parse`, `R2-dup-piper-host-parse`); make the settings migration atomic (`R4-migration-not-atomic`); document why `pingpong`/the no-op LoRA node exist (note-mandated). Remaining SUGGESTIONs deferred.
- [x] T3a Draft generation (article fetch → Ollama → validated escaleta) — `6856475` (article + draft) and `759722f` (repository + endpoints), ~830 lines incl. ~400 of tests (over the ~400 heuristic: three behaviors plus tests). Parent re-verified 147 pass / 0 fail, typecheck clean. Decisions: invalid model output → 502; PUT keeps per-scene edited voices (falls back to the draft's voice rule); article wrapped in `<article>` with an ignore-instructions line; private-network URLs allowed by design (scheme, credentials, size, time limits apply).
- [x] T3c-first (`1add6a4` jobs table/repo, `4fda842` hub, `ce91323` runner, `9eccc60` routes+wiring; ~1,236 lines incl. ~700 tests; delegated writer; parent re-verified 189 pass; native review approved, 3 advisory SUGGESTIONs) Job infrastructure (moved before T3b because the orchestrator runs inside a job): `jobs` table + repository, single-slot queue (one GPU job at a time), in-memory event hub, restart recovery (running → failed `interrupted`), `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE: snapshot, `: ping`, live), `POST /api/jobs/:id/cancel`, `GET /api/jobs/:id/output`.
- [x] T3b Approval orchestrator with SSE — `3b79032` (wav + ffmpeg helpers), `88e0f18` (orchestrator), `0487cc8` (SSE refactor + approve route + wiring); ~1,000 lines incl. tests; parent re-verified 213 pass. Design: single-frame Wan T2V per scene → still PNG, I2V transitions (33 frames) between consecutive stills with hard-cut fallback, Ken Burns per still sized to its narration WAV, narration track with silence in transition slots, mux. ASSUMPTIONS NOT YET VERIFIED AGAINST REAL COMFYUI: single-frame T2V (`num_frames: 1`) works with the Wan chain; ComfyUI renders at 16 fps so a transition lasts `frames/16` s.
- [x] T3e (`pingpong` fix, ~28 lines; RED on 2 assertions → GREEN 215/215): `VHS_VideoCombine.pingpong` is now an option (default `true`, the note's chain default); the orchestrator passes `false` for stills and transitions so a transition ends on its end image and lasts `frames/16` s.
- [x] T3d (`2212c3f`) Make the ComfyUI request timeout per-operation (short for polling/submit, long for `download`/`uploadImage`), plus the advisory SUGGESTIONs on article charset/entities if cheap.
- [x] T3f (~193 lines incl. tests; delegated writer; RED on 3+1+1 assertions → GREEN, suite 215 → 221) Fixes from the orchestrator review's advisory WARNINGs: approve is one SQLite transaction (draft status + job row; loop kick after COMMIT) and can be retried when the latest job failed/cancelled (also for an approved draft with no job); progress is monotonic; mixed WAV formats fail the job before any ComfyUI work. Remaining advisory items deferred: transition seed magic offset, `format` non-null cast, transition timeout without `interrupt`, `wav.ts` parse edge (R1-001).
- [x] T4a Frontend scaffold, API client, settings modal, sidebar (`04fcebc..6587212`, 40 tests)
- [x] T4b Pipeline form, progress stages, video panel (`885e069..4311885`, 75 tests). Deviation: no separate `<audio>` (backend only produces the muxed mp4).
- [x] T4c Escaleta cards and SegmentEditor review mode, plus T4d hook fixes (`691f27e..2268f0a`; frontend 120 tests, backend 221; all native reviews approved, advisory items listed below)
- [x] T5a PipelineAgent with **Ollama tool-calling** (CHANGED 2026-10-04 by user: "cambia el sdk de anthropic por ollama" — Atlas note's Anthropic SDK/`claude-opus-4-8` line is obsolete; T5b updates it). `backend/src/pipeline/agent.ts`: single tool `submit_workflow(workflow, mode)` against Ollama `/api/chat` with native `tools`, system prompt encodes the full Wan2.2/WanVideoWrapper know-how (exact nodes, model names, `wan_2.1_vae bf16` never changes, omit `end_image` when absent, 720p/81fr/50 steps/cfg 6.0/unipc/20 block swap), `generate(req)` → `{ promptId, mode }` at the first valid tool call, otherwise `PipelineAgentError` (no tool call, bad mode, empty workflow, malformed args). Not wired to the orchestrator (manual step, per the note). Model chain: `opts.model ?? OLLAMA_MODEL ?? qwen3:8b`. Route: inline (writer trigger fired — 2 non-trivial files — but no subagent mechanism is exposed in this pi runtime). TDD ON, runner `node --test --import tsx`. RED: module-not-found on `../src/pipeline/agent`. GREEN: 9/9 agent tests; parent re-verified suite **230 pass / 0 fail**, typecheck clean. **Commit `e64340b`** (`feat(backend): add PipelineAgent using Ollama tool-calling for Wan2.2 workflows`).
- [x] T5b README/setup docs and Atlas note update — **commit `bf5e6bc`** (`docs: record phase 5 completion`; amended after the T5a SHA placeholder was filled in).; Atlas note updated in the Obsidian vault (`/mnt/nas/Obsidian/Proyectos/video-studio.md`). README: Phase-2 text uses Piper (Wyoming), stack table, PipelineAgent (Ollama) section, recreation + `FelipePepe/video-studio` (private) status, Running + API sections, tests 230/120. Atlas note `Proyectos/video-studio.md`: status → recreado+activo (repo path, private remote, PR chain, 230/120 tests, single-frame T2V pending); `[!info]` keeps the 2026-10-04 not-found finding; TTS row → Piper (Kokoro descartado 2026-10-04); Agente IA row → Ollama tool-calling (historical Anthropic line annotated); flow diagram; `piper_host` + migration. Wikilinks preserved. Route: inline (docs, 2 files).

## Acceptance criteria
- `pnpm -r test` green; `pnpm -r typecheck` clean.
- Workflow-builder tests encode the VAE and parameter rules from the note.
- Draft → review → approve flow works end to end with fake clients; real-host run only with user authorization.

## Progress
- 2026-10-04: plan approved. T0 done (`a0c05bd`). Running slice count: 271 authored lines (incl. this doc).

## Verification evidence
_(none yet)_

## Review assessments per task
Last reviewed boundary: `2268f0a` (end of phase 4). Phase 5: T5a (`e64340b`) — range `2268f0a..e64340b`, risk medium (`executable_change`: `agent.ts`), 361 lines, `review_due: false` (`under_budget`); pending in the slice.
Phase 4 reviews (all medium, 1 lens, approved, acknowledged): T3f+T4a `review-0a9007ad484a54f2`, T4b `review-cb78406645df3ccb`, T4c/T4d `review-eb6e45cecd2b5c8a`. Open advisory: `createDraft` guard is silent, focus-after-move unasserted, stale-save untested.
- T0 (`a0c05bd`): risk medium (`executable_change`: `.npmrc`), `review_due: false`, reason `under_budget` (271 lines). Pending in the slice until T1.
- T1 (`78668eb`): range `635c61e..78668eb`, risk medium, `review_due: true` (`slice_budget_reached`; 1791 lines counted, 1163 of them the generated lockfile). Consent granted by the user; one lens (`review-reliability`) → **approved**, acknowledged, authority burned (lineage `review-f093030dc3f776be`). Three non-blocking advisory findings (see T1b).

- T1b (`9d69315`): range `78668eb..9d69315`, 168 lines, medium, `review_due: false` (`under_budget`); folded into the phase-2 range.
- Phase 2 (`c1c7248..68c3320`): range `9d69315..HEAD`, high (`process_boundary` in `ffmpeg.ts`), `review_due: true` (`high_risk`). User granted consent; 4 lenses → `correction_required` (CRITICAL: `kokoro_host` rename without migration, found by reliability + resilience). One bounded correction (`68c3320`, ~51 lines of 200 budget). Native flow then required a maintainer recovery authorization (`scope_changed`); the user authorized it; `gentle-ai review recover` derived the binding and created successor `review-babf1faa9cb4fed2-r1`; 4 lenses → **approved**, acknowledged, authority burned. 13 advisory findings (→ T2e).
- Phase 3 part 1 (`ceaf96c..759722f`): range `68c3320..759722f`, medium (`executable_change`: `app.ts`), `review_due: true` (`slice_budget_reached`, 1054 lines). User granted consent; 1 lens (reliability) → approved, acknowledged (lineage `review-c1d63844c8e05d9f`). 5 advisory findings; the WARNING `R3-comfy-timeout-applies-to-all-requests` (the 30 s request timeout also hits `uploadImage`/`download` of large files) is queued as T3d.
- Phase 3 part 2 (`2212c3f..9eccc60`): range `759722f..9eccc60`, medium, 1354 lines, `review_due: true` (`slice_budget_reached`). User granted consent; 1 lens (reliability) → approved, acknowledged (lineage `review-c751f0ed3cea429c`). 3 advisory SUGGESTIONs (cooperative cancel, weak poll-timeout assertion, `idle()` before `start()`).
- Phase 3 part 3 (`3b79032..832fa68`): range `9eccc60..832fa68`, high (`process_boundary`, `ffmpeg.ts`), 1050 lines, `review_due: true` (`high_risk`). User granted consent; 4 lenses → approved without correction, acknowledged (lineage `review-d027623226958574`). 10 advisory findings; the 3 behavior-affecting ones were fixed in T3f. T3e (`pingpong`) was fixed before this review started.

## Slices (PRs)
Branch chain (local): `develop` ← `feature/video-studio-rebuild` (root, `a0c05bd` bootstrap) ← `feature/video-studio-rebuild-p1` (T1, T1b) ← `-p2` (T2a–d) ← `-p3` (T3a–c) ← `-p4` (T4a–c) ← `-p5` (T5a–b).
Remote: `FelipePepe/video-studio` (private, created at the user's request). PR #1 (p1 → root), PR #2 (p2 → p1), PR #3 (p3 → p2), PR #4 (p4 → p3), PR #5 (p5 → p4) opened; the agent never merges. Final PR `feature/video-studio-rebuild` → `develop` opens once the user merges the chain. The enhancement feature (bgm/subtitles/vertical+thumb/voices, planned 2026-10-04) cuts its own root branch from `feature/video-studio-rebuild-p5`.

## Open items
- `visual-character-sync` has no spec.
- TTS is Piper (Wyoming, `tcp://192.168.1.60:10200` default), not Kokoro as the Atlas note says; the Atlas note was corrected in T5b (2026-10-04).
- Wyoming protocol verified against real spark (2026-10-04, user-authorized, read-only probe `describe` + one 1.6 s synthesis at `192.168.1.60:10200`): events carry data via `data_length` (not inline), `audio-start` → ~36 `audio-chunk` → `audio-stop`, 22050 Hz 16-bit mono, 163 voices incl. `es_ES-davefx-medium` and `es_ES-sharvard-medium` (speakers `M`,`F`; index 1 accepted). The PiperClient itself is still tested only against a local fake server that mirrors these facts; running the client end to end against spark needs a further check.
- PR #1 (`p1` → `feature/video-studio-rebuild`) is open: https://github.com/FelipePepe/video-studio/pull/1 (repo `FelipePepe/video-studio`, private, created 2026-10-04 at the user's request).

## Next step
Enhancement feature (post-phase-5 plan, approved 2026-10-04 by the user over the MoneyPrinter* analysis): **E1 BGM + ducking** (MoneyPrinterTurbo `bgm.py` pattern → our ffmpeg mix), **E2 burned subtitles** (SRT/ASS from escaleta + per-scene WAV timings), **E3 vertical 9:16 crop + cover thumb**, **E4 `GET /api/voices`** (Piper voice list). Root branch from `feature/video-studio-rebuild-p5`, one feature doc `odd/tasks/video-studio-enhancements.md`, phase branches + PRs per the cached `feature-branch-chain` strategy; final root PR → `develop` after the rebuild chain. Pending authorization: real spark run of single-frame Wan T2V (+ real Piper client e2e).

(previous next-step text:)
T1b (hardening, delegated writer), then phase 2 (T2a–d).

User goal (2026-10-04): "implementa todas las fases" — continue through all phases without stopping between tasks, pausing only for real decisions/authorizations (remote repo, real-host runs on spark).
