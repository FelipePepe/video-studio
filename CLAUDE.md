# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Personal pnpm monorepo (`backend/` Express + `node:sqlite`, `frontend/` React/Vite) that turns an article into a narrated video: Ollama writes a JSON scene script (*escaleta*), a human reviews it, then Piper TTS + ComfyUI (Wan2.2) + ffmpeg render it. See `README.md` for API routes and `docs/adr/0001-pipeline-architecture.md` for the rationale behind the decisions below.

## Commands

Requires Node >= 22.5 (`node:sqlite`), pnpm, and ffmpeg on `PATH`.

```bash
pnpm install
pnpm test                 # all workspaces (backend: node:test via tsx, frontend: vitest)
pnpm typecheck
pnpm --filter @video-studio/backend dev     # backend on :3001 (tsx watch)
pnpm --filter @video-studio/frontend dev    # Vite; proxies /api -> localhost:3001
docker compose up -d --build                # backend + nginx web on :20014 (see README "Docker")

# single test
cd backend && node --test --import tsx test/orchestrator.test.ts
cd frontend && pnpm vitest run test/ReviewPanel.test.tsx
```

Backend env: `PORT`, `HOST`, `DB_PATH` (default `data/video-studio.sqlite`), `API_TOKEN` (optional shared-token guard on state-changing routes), `LOG_LEVEL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX` (optional; sent as Ollama `num_ctx` only when set), `OLLAMA_TIMEOUT_MS` (chat timeout, default 300000), `OLLAMA_TAGS_TIMEOUT_MS` (model list timeout, default 5000), `DRAFT_MAX_CONCURRENCY` (concurrent `POST /draft`, default 2; extra requests get 429), `FFMPEG_STALL_TIMEOUT_MS` (ffmpeg watchdog, default 1800000), `MUSIC_DIR`, `CACHE_TTL_DAYS` (default 30) and `CACHE_MAX_GB` (default 20) for the content-cache retention. Runtime data and logs live in `data/` (gitignored).

## Architecture

- **Two-phase, human-gated pipeline.** `POST /api/pipeline/draft` produces a persisted draft; the user edits segments; `POST .../approve` creates a *job*. Re-approve is only allowed when the draft's latest job is `failed`/`cancelled` (409/404 otherwise).
- **Static orchestrator** (`backend/src/pipeline/orchestrator.ts`, `createExecute`): hard-wired `tts → images → transitions → assemble`, each a `step()` with guard/fail/abort semantics. ffmpeg work is split into pure argument builders in `backend/src/media/ffmpeg.ts`, so tests don't need a GPU or real ffmpeg. Approve options are a strict allowlist (`parseApproveOptions`); unknown keys are rejected.
- **Jobs** (`backend/src/jobs/`): `JobRunner` + SQLite `jobRepository`; progress goes through `EventHub` to SSE (`/api/jobs/:id/events`). Artifacts (`final.mp4`, `final_v.mp4`, `cover.jpg`) are served from the job dir.
- **Clients + runtime config.** `backend/src/clients/` wraps ComfyUI, Ollama and Piper (Wyoming over TCP). Hosts are resolved per call via `resolveEffectiveConfig` (env defaults overridden by persisted settings, editable through `/api/config`), so changing a host needs no restart.
- **`buildApp(opts)`** (`backend/src/app.ts`) is the composition root; every client, the DB, ffmpeg and the job `execute` function are injectable. Tests rely on this (in-memory DB, fake clients) — follow the same seam when adding dependencies.
- **`PipelineAgent`** (`backend/src/pipeline/agent.ts`) is a deliberately unwired alternative (Ollama tool-calling); don't assume it is in the production path.
- **Frontend**: single SPA, two hash views (`#pipeline`, `#trabajos`), no router library, one global tokenised `styles.css`, ES/EN i18n in `src/i18n.tsx`. Pipeline state lives in `hooks/usePipeline.ts`; API access in `src/api/client.ts` (tests use `test/helpers/fakeApi.ts`).
- **Logging**: use `logger.child('<scope>')` from `backend/src/lib/logger` (file + console; scopes like `http`, `jobs`). Frontend logger is an in-memory ring buffer (`window.__vsLogs`).

## Workflow conventions

- GitFlow: work on `feature/*`, PR into `develop`. lefthook blocks commits on `main`/`develop` and runs `gitleaks` on staged files.
- Conventional commits. CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test`.
- Task tracking for substantial features lives in `odd/tasks/<feature>.md`; `docs/plan-pendiente-executable.md` holds the pending-work plan.
- Paths for workDir/cacheDir must be absolute (relative paths broke ffmpeg concat lists — see commit 1deb9bd).
