# wp7-lifecycle-disk-hygiene

**Status:** implemented, PRs open (#62, #63, PR3) · **Updated:** 2026-10-24
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/` · **Plan:** `docs/plan-mejoras-optimizacion.md` WP7 (B4, B5, B6, B8, B9)
**Engram mirror:** `odd/wp7-lifecycle-disk-hygiene/tasks` (project video-studio, saved with `engram save`)

## Objective
Make the backend survive slow/hung upstreams and orderly shutdowns, and stop leaking partial files and disk.

## Scope (delivery slices, each its own PR into `develop`)
- **PR1 · B4** — Ollama timeout/abort (`OLLAMA_TIMEOUT_MS`, `OLLAMA_TAGS_TIMEOUT_MS`), abort on client disconnect, `DRAFT_MAX_CONCURRENCY` limit (429) on `/draft`.
- **PR2 · B5 + B6** — `JobRunner.stop()` + `lib/shutdown.ts` (SIGTERM/SIGINT, `listen` error handler, `db.close()`), ffmpeg stall watchdog (`FFMPEG_STALL_TIMEOUT_MS`) and best-effort cleanup of the partial output (last arg).
- **PR3 · B8 + B9** — cache TTL/LRU + periodic prune, atomic cache writes, `copyFile`, WAV validation (later).

## Constraints
TDD ON (runner: `pnpm --filter @video-studio/backend test` = `node --test --import tsx`). Conventional commits, no AI attribution, never merge unasked, PR into `develop`. No live shutdown test: the compose stack on maya may be running a render.
Defaults: `OLLAMA_TIMEOUT_MS=300000`, `OLLAMA_TAGS_TIMEOUT_MS=5000`, `DRAFT_MAX_CONCURRENCY=2`, `FFMPEG_STALL_TIMEOUT_MS=600000` (stall/inactivity watchdog), shutdown hard-exit 8 s, compose `stop_grace_period: 15s`. A job aborted by shutdown stays `cancelled`.

## Route declaration
Per PR: tests+code delegated to ONE bounded writer (sonnet) with an exact spec (writer trigger: >=2 non-trivial files); parent reviews every file, runs the checks, commits, opens the PR.

## Tasks
- [x] **T1** PR1 / B4 — tests RED then code (ollama.ts, draft.ts, routes/pipeline.ts, routes/ollamaModels.ts) + env docs
- [x] **T2** PR2 / B5 + B6 — tests RED then code (runner.stop, lib/shutdown.ts, server.ts, ffmpeg.ts, orchestrator run wrapper, compose)
- [x] **T3** PR3 / B8 + B9

## Acceptance
Backend `pnpm test` + `pnpm typecheck` green; every new test observed RED first; PR bodies state what was NOT verified (real SIGTERM in Docker, real Ollama timeout).

## Progress / evidence
- PR1 (B4): tests written first by a bounded writer (sonnet), RED observed (ollama timeout/abort x6, draft+publish signal forwarding, models hung, route disconnect); parent review fixed an indentation slip and added the missing `DRAFT_MAX_CONCURRENCY` parsing test. Backend 364/364 pass, `pnpm typecheck` OK, `docker compose config -q` OK. Not run: any real Ollama, docker, frontend tests.

## Next step
PR1 = #62. PR2 (B5+B6) open, stacked on PR1 (same env/compose/docs files). Next: T3 (PR3: B8 + B9).
- PR1 follow-up: native review (3 non-blocking findings) fixed; backend suite 11 s / 369 tests (a never-settling test fake had kept a 300 s timer alive).
- PR2 (B5+B6): bounded writer (sonnet), RED observed (runner.stop x5, shutdown module missing, ffmpeg timeout/abort/precedence, orchestrator partial-output cleanup x3); parent review: `runOne` assigns `current` synchronously after the queue shift, so `stop()` always reaches the running job. Backend 387/387 in ~12 s, typecheck OK, compose OK. Deviation: the ffmpeg watchdog timer is not `unref`'d (cleared on every exit path). NOT verified: real SIGTERM in Docker (`stop_grace_period` only validated statically), real ffmpeg, real `listen` error.
- Decisions recorded in Engram: F6 transition policy (#3402), threat model (#3403).
- PR2 follow-up: native review (high risk, 4 lenses) approved; fixed the watchdog (total-time -> stall/inactivity because this host is a Raspberry Pi and ffmpeg prints progress; capped at the largest setTimeout delay), the ref'd hard timer and smaller items. PR #63 stacked on #62.
- PR3 (B8+B9): bounded writer (sonnet), RED observed (15 failing tests across contentCache/orchestrator); parent review of contentCache/orchestrator diff. Backend 407/407 in ~12 s, typecheck OK, compose OK. NOT verified: a real prune against a big cache, real ENOSPC, `server.ts` wiring (no test seam: `main()` runs on import). Deviation: `stop()` of the pruner is not wired into the shutdown (timer is unref'd).
