# plan-mejoras-wp5-wp14

**Status:** in progress · **Updated:** 2026-10-31
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
- [x] WP7 — merged 2026-10-31: B4 = `#62` (17084e8), B5+B6 = `#70` (52d50f1), B8+B9 = `#71` (4f5d1fb)
- [x] WP9 data layer — merged 2026-10-31 as `#72` (8fe5e02)
- [x] WP5 transition failure policy + persisted job warnings (F6) — merged 2026-10-31 as `#73` (8b90bea)
- [x] WP6a render performance (P1 one-pass vertical, P3 throttled progress, P4 -ss input-side cover) — merged 2026-10-31 as `#74` (580bffa)
- [ ] WP6b (P2 Ken-Burns / transition overlap + prompt pre-queue) — highest risk, own slice
- [ ] WP8 subtitles / ffmpeg hygiene (F7, B7)
- [ ] WP10 frontend resilience (F10, U1, P6; F3 already done)
- [ ] WP11 accessibility / i18n / assets (2 PRs)
- [ ] WP11b visual polish (V1-V3, V5-V7)
- [ ] WP12 (reduced) security hygiene
- [ ] WP13 maintainability (M1, M2, U8, B10, B11)
- [ ] WP14 docs and housekeeping (README pnpm version, plan status, Atlas sync)

## Progress / evidence
- **WP5** (PR #66): backend half from the previous session (7afab70 + docs 4005ed3) reviewed file-by-file and re-verified: typecheck ✔, backend 440/440 ✔, frontend 208/208 ✔. Frontend slice written RED-first by the parent inline (pi session, no subagent delegation mechanism — trigger evidence: 5 src/test files, no mapper/writer available; inline route chosen and kept bounded): `Job.warnings` type, `JobsPage` warnings list as a `note` landmark with new `jobs.warnings`/`Warnings` i18n keys, same landmark on the live `ProgressStages` block, mocks learned the field. Commit 3546a96 (8 files, +42/−3). RDD (global on): risk medium, `review_due=slice_budget_reached` (444 lines base a135e35), consent granted by the user, review-reliability lens completed 23/23 paths with 0 findings, acknowledged and authority burned (envelope `review/acknowledged`).
- **WP9** (PR #65): bounded writer (sonnet), RED observed (new exports missing -> file failed to load), parent review of connection.ts. Backend 417/417 in ~12 s, typecheck OK; plain `tsc` emit opens a DB with no .sql file (proof run by the writer, `user_version: 2`). Legacy helpers lost their own BEGIN/COMMIT because the runner already holds the transaction (SQLite has no nested BEGIN). NOT verified: the legacy upgrade was built by hand, not run on the production DB.

## Merge log (2026-10-31)
All six slices landed on develop. Merging `#62` made GitHub auto-close the stacked PRs (reopen blocked: deleted base branches), so the rest were rebuilt by cherry-picking each slice's commits onto the live develop — `#70` (B5+B6), `#71` (B8+B9), `#72` (WP9), `#73` (WP5), `#74` (WP6a) — each CI green, squash-merged, branches deleted. Stale PRs #64-#69 closed with pointers. Union verified on develop: typecheck + tests green (frontend 208/208, backend all pass).

## Next step
**WP6b** (P2: Ken-Burns / transition overlap + prompt pre-queue) — highest risk, own slice. Then WP8, WP10, WP11(+11b), WP12, WP13, WP14.
