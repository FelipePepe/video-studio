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
- [ ] T0 Bootstrap: git, main/develop, feature branch, pnpm monorepo, lefthook, README — route: inline (mechanical config files)
- [ ] T1 Backend foundation: node:sqlite connection + schema, server settings, buildApp with lazy clients, GET/PATCH /api/config — route: delegated writer
- [ ] T2a ComfyUI client (submit, poll, upload, download)
- [ ] T2b Ollama + Kokoro clients
- [ ] T2c ffmpeg assembly helpers (Ken Burns, xfade, concat, mux)
- [ ] T2d Wan2.2 T2V/I2V workflow builders
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
- 2026-10-04: plan approved. T0 in progress.

## Verification evidence
_(none yet)_

## Review assessments per task
_(none yet)_

## Slices (PRs)
_(none yet)_

## Open items
- `visual-character-sync` has no spec.
- Kokoro host unknown (note says `localhost:8880`); configurable via settings.

## Next step
Finish T0: commit bootstrap on `feature/video-studio-rebuild`.
