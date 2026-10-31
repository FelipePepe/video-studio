# video-studio

Personal tool that generates videos from articles (URL or plain text).

Pipeline, in two phases:

1. **Draft:** an article goes to a local Ollama model, which writes a JSON scene script (*escaleta*). A human reviews and edits it.
2. **Approve:** Piper TTS (Wyoming protocol) narrates each scene; ComfyUI (Wan2.2 T2V/I2V) generates a still per scene plus I2V transitions between stills, sized to the narration; ffmpeg assembles the final video.

An optional standalone **PipelineAgent** (`backend/src/pipeline/agent.ts`) is the dynamic alternative to the static workflow builder: it runs Ollama tool-calling (`submit_workflow`) with a system prompt that encodes the Wan2.2 know-how, and is not wired to the orchestrator yet.

This project is a recreation of a previous repo that was lost (searched on 2026-10-04: not found); the spec comes from the Atlas note `Proyectos/video-studio`. The repo was recreated on 2026-10-04 and lives at this path; remote: `FelipePepe/video-studio` (public).

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite 5, TypeScript, Vitest + jsdom |
| Backend | Node.js + Express 4, TypeScript (CommonJS), `node:sqlite`, `node:test` |
| Visuals | ComfyUI + Wan2.2 via WanVideoWrapper |
| Script | Ollama |
| TTS | Piper (Wyoming, `tcp://192.168.1.60:10200`, voices `es_ES-*`)
| Assembly | ffmpeg |
| Monorepo | pnpm workspaces |

## Requirements

- Node.js >= 22.5 (for `node:sqlite`)
- pnpm 10
- ffmpeg on `PATH`
- Reachable ComfyUI, Ollama and Piper hosts (configurable at runtime from the Settings modal)

## Running

```bash
pnpm install
pnpm -r test        # backend (node:test) / frontend (Vitest)
pnpm -r typecheck
pnpm --filter @video-studio/backend dev   # backend :3001
```

## Docker

Two services: `backend` (Node 22 + ffmpeg, never published) and `web` (nginx serving the built SPA and proxying `/api` with SSE unbuffered). Only `web` publishes a port.

```bash
mkdir -p data                   # owned by you (uid 1000); Docker would create it as root and the backend could not write
cp .env.example .env            # adjust hosts/ports if needed
docker compose up -d --build    # first start or after a git pull
docker compose logs -f backend
curl http://localhost:20014/api/config   # health check through the proxy
```

- **Port:** `WEB_PORT` (default `20014`, from the house `20000+` range for Docker services on maya). `WEB_BIND` defaults to `0.0.0.0` like the other services; set `WEB_BIND=127.0.0.1` to keep it reachable only from the host. The app has no login, so only expose it on a trusted network.
- **Data:** `DATA_DIR` (default `./data`) is bind-mounted at `/app/backend/data` (SQLite, jobs, cache, logs). It is a bind mount, not a named volume, so it survives a Docker reset.
- **Hosts:** `COMFY_HOST`, `OLLAMA_HOST` and `PIPER_HOST` are only defaults: values saved from the Settings modal live in the database and take precedence.
- **Ollama limits:** `OLLAMA_TIMEOUT_MS` (chat, default `300000`), `OLLAMA_TAGS_TIMEOUT_MS` (model list, default `5000`) and `DRAFT_MAX_CONCURRENCY` (simultaneous draft generations, default `2`; extra requests get `429` with `Retry-After`). Empty means default.
- **ffmpeg watchdog and shutdown:** `FFMPEG_STALL_TIMEOUT_MS` (default `600000` = 10 min without any ffmpeg output; empty means default) kills a hung ffmpeg and removes its partial output. It is an inactivity limit, not a total-time limit: a slow encode that keeps printing progress is never killed. On `SIGTERM`/`SIGINT` the backend aborts the running job, closes the server and the database; compose sets `stop_grace_period: 15s`, above the 8 s hard-exit timeout.
- **`API_TOKEN`:** not passed through. The SPA never sends it, so enabling it would break the UI; it only makes sense for non-UI clients on a directly published backend.
- **Cache retention:** `data/cache` is pruned at start and every 6 h: entries unused for `CACHE_TTL_DAYS` (default `30`) are removed, then least-recently-used entries until it fits `CACHE_MAX_GB` (default `20`); empty means default. Cache writes are atomic (temp file + rename), so a crash never leaves a truncated entry.
- **Redeploy:** `git pull && docker compose up -d --build`.

## Logging

- **Backend** (`backend/src/lib/logger`): structured line `ISO_ts level [scope] message {meta-json}` written to `data/logs/video-studio.log` (rotated to `video-studio.log.old` at 5 MB) and echoed to the console. Scope per module: `app.http`, `app.server`, `app.jobs`, `app.events`, `app.pipeline`. Levels: `debug|info|warn|error`, set with `LOG_LEVEL` (default `info`). Error entries include the stack trace in `meta.err`.
- **HTTP**: every request logs `method`, `path`, `status` and `ms`; unhandled 500s are logged with the error.
- **Frontend** (`frontend/src/lib/logger`): in-memory ring buffer (last 500) + browser console. Inspectable in DevTools via `window.__vsLogs.getLogs()`. No new network endpoint.
- Logs are in `data/logs/` (already gitignored); nothing leaves the box.

## API

- `POST /api/pipeline/draft` — Ollama escaleta (no TTS yet)
- `PUT /api/pipeline/draft/:id/segments` — human review / editing
- `POST /api/pipeline/draft/:id/approve` — TTS + ComfyUI + ffmpeg, SSE progress. Opcional `{ music, musicVolume?, subtitles?, vertical? }`
- `GET /api/pipeline/voices` — roster de voces de Piper (Wyoming `describe`), `?lang=es` filtra
- `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE), `POST /api/jobs/:id/cancel`
- `GET /api/jobs/:id/output` — `?variant=vertical` (9:16, `final_v.mp4`) o `?variant=cover` (`cover.jpg`)
- Jobs carry a `warnings` array (max 50 entries of 500 chars). A transition that fails is replaced by a hard cut and a warning is recorded; the job is aborted only after 2 consecutive ComfyUI infrastructure failures (unreachable, timeout, lost prompt, HTTP 5xx). A prompt ComfyUI rejects (4xx, execution error) never counts toward the abort.
- `GET/PATCH /api/config` — ComfyUI / Ollama / Piper hosts

## Workflow

GitFlow: `main` / `develop` / `feature/*`. Direct commits to `main` and `develop` are blocked by lefthook. Conventional commits only.

## Status

Core pipeline, editorial review, job infra and frontend are complete (phases 1–5 done 2026-10-04); PR chain stacked over `develop`. Not yet verified end to end against real ComfyUI (single-frame T2V assumption). See `odd/tasks/video-studio-rebuild.md` for the task list and progress.
