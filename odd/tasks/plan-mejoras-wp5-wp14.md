# plan-mejoras-wp5-wp14

**Status:** in progress · **Updated:** 2026-10-24
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/` · **Plan:** `docs/plan-mejoras-optimizacion.md` (WP1-WP4 already merged in develop)
**Engram mirror:** `odd/plan-mejoras-wp5-wp14/tasks` (project video-studio)

## Objective
Implement the remaining work packages of the optimization plan, one PR per slice (never merged by me), stacked in this order so shared files (env docs, compose) do not conflict.

## Decisions (user, 2026-10-24)
- **F6 (WP5):** degrade to a hard cut when ComfyUI rejects/fails that prompt; abort after N=2 consecutive infrastructure failures (unreachable/timeout); persist warnings on the job and show them in Jobs (Engram #3402).
- **Threat model (WP12):** trusted LAN only -> WP12 reduced to a bind-without-token startup warning, `x-powered-by` off and documenting the assumption (Engram #3403).

## Constraints
TDD ON (backend `node --test --import tsx`, frontend `vitest run`). Conventional commits, no AI attribution, PR into the previous branch of the stack (retarget to `develop` as they merge). Native review per slice when due (consent from the user each time). Do not touch the live compose stack on maya (a render may be running). Real-service checks (Piper, ComfyUI, browser) are NOT run by me unless authorised; each PR states what was not verified.

## Route declaration
Per slice: one bounded writer (sonnet) with an exact spec (writer trigger); parent reviews every file, runs the checks, commits, runs the review flow and opens the PR.

## Slices (stack order)
- [x] WP7 · #62 B4 Ollama timeouts/limit -> #63 B5+B6 shutdown/ffmpeg stall watchdog -> #64 B8+B9 cache
- [x] WP9 data layer (user_version migrations, jobs indexes, schema embedded in TS) — prerequisite of WP5
- [ ] WP5 transition failure policy + persisted job warnings (F6, decided)
- [ ] WP6 render performance (P1-P4)
- [ ] WP8 subtitles / ffmpeg hygiene (F7, B7)
- [ ] WP10 frontend resilience (F10, U1, P6; F3 already done)
- [ ] WP11 accessibility / i18n / assets (2 PRs)
- [ ] WP11b visual polish (V1-V3, V5-V7)
- [ ] WP12 (reduced) security hygiene
- [ ] WP13 maintainability (M1, M2, U8, B10, B11)
- [ ] WP14 docs and housekeeping (README pnpm version, plan status, Atlas sync)

## Progress / evidence
- **WP9** (PR below): bounded writer (sonnet), RED observed (new exports missing -> file failed to load), parent review of connection.ts. Backend 417/417 in ~12 s, typecheck OK; plain `tsc` emit opens a DB with no .sql file (proof run by the writer, `user_version: 2`). Legacy helpers lost their own BEGIN/COMMIT because the runner already holds the transaction (SQLite has no nested BEGIN). NOT verified: WP5's `jobs.warnings` migration (comes next); the legacy upgrade was built by hand, not run on the production DB.

## Next step
WP5.
