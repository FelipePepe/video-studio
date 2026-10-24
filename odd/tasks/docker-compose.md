# docker-compose

**Status:** implemented, PR pending · **Updated:** 2026-10-24
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/` · **Branch:** `feature/docker-compose` (from develop @ 661b5b6)
**Engram mirror:** `odd/docker-compose/tasks` (project video-studio, saved with `engram save`; MCP mem_save needs a session id)

## Objective
Run the app as a Docker Compose stack on maya (backend + web) so it can be redeployed with one command and picks up fixes such as v0.2.1.

## Why / findings
- Backend does not serve the SPA (Vite proxies `/api` in dev) -> second service with built SPA + nginx proxy, SSE unbuffered.
- Backend binds 127.0.0.1 by default -> `HOST=0.0.0.0` inside the container, backend never published.
- Needs Node >= 22.5, ffmpeg on PATH; starts with tsx (devDependency); state in `data/` resolved against cwd.
- Atlas port convention (Setup/Red-Local-Servicios.md): new Docker services in 20000+; **20014** is free and unmentioned.
- Atlas: Docker lost named volumes after an unclean reboot -> bind-mount `data/`.
- Frontend never sends `API_TOKEN`; injecting it in nginx would defeat it -> off by default, only `web` is published.

## Scope
New: `docker/backend.Dockerfile`, `docker/web.Dockerfile`, `docker/nginx.conf`, `.dockerignore`, `docker-compose.yml`, `.env.example`; docs in README/CLAUDE.md; Atlas port row.
Out of scope: `.casa` domain/nginx/DNS (nueva-casa skill), any remote host, CI image build, registry publishing, app code changes.

## Constraints
No `docker build`/`up` by me (global rule: never build after changes); static validation with `docker compose config`. TDD n/a (config files). Conventional commits, no AI attribution, PR into develop, never merge unasked.

## Route declaration
T1+T2: one bounded writer (Agent, sonnet) — 5+ new non-trivial files from a precise spec (writer trigger). T3 + validation + Atlas: parent inline (docs, 1-2 files each).

## Tasks
- [x] **T1** Images: `docker/backend.Dockerfile`, `docker/web.Dockerfile`, `docker/nginx.conf`, `.dockerignore`.
- [x] **T2** Stack: `docker-compose.yml`, `.env.example`; `docker compose config` passes.
- [x] **T3** Docs: README `## Docker`, CLAUDE.md line. (Atlas port row 20014 + project note: after the PR is accepted.)

## Acceptance
`docker compose config -q` (also with `--env-file .env.example`) passes; only `web` publishes a port (`${WEB_BIND:-0.0.0.0}:${WEB_PORT:-20014}:80`); nginx `/api/` has `proxy_buffering off` and long read timeout; no secrets committed. Runtime (build, tsx start, ffmpeg, SSE) is NOT verified by me and the PR says so.

## Progress / evidence
- T1 `01b2cac` images · T2 `fec84e1` compose + env · T3 docs commit follows.
- Route: T1+T2 delegated to one bounded writer (Agent, sonnet; 6 files, 217 lines); parent reviewed every file and fixed 3 issues: nginx resolved `backend` once at startup (stale IP after a redeploy -> now `resolver 127.0.0.11` + variable proxy_pass), `text/javascript` missing in gzip_types, and `data/` not existing (Docker would create it root-owned -> README `mkdir -p data`).
- Checks observed: `docker compose config -q` OK (also with `--env-file .env.example`: web 0.0.0.0:20014->80, backend expose 3001 only, bind mount ./data -> /app/data); `nginx -t` OK in a throwaway `nginx:1.27-alpine` container; backend treats empty env strings as unset (settings.ts `||`, ollama/retention parsers).
- NOT verified (no image build allowed): `docker compose build`, tsx start in the container, ffmpeg in the image, `LEFTHOOK=0` suppressing lefthook's postinstall, container healthchecks, SSE pass-through, uid 1000 writing the bind mount.

## Next step
Open the PR; Atlas port row after acceptance; the user builds and runs it.
