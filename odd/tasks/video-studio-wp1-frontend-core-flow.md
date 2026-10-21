# video-studio-wp1-frontend-core-flow

**Status:** in progress · **Branch:** `feature/wp1-frontend-core-flow` (cut from local develop @ cf09982)
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/`

## Objective
Fix the three P0/P1 main-flow defects that make finishing a video a dead-end, approving music a no-op, and failures opaque (catalogue F1, F2, F4 in `docs/plan-mejoras-optimizacion.md`).

## Tasks
| ID | Finding | Change |
|----|---------|--------|
| T1 | F1 | New video after `done`: `pipeline.newVideo` key, `PipelineForm.disabled?`, `PipelinePage` new-video button + form disabled off-idle. |
| T2 | F2 | Music default track from library + `review.musicRequired` message instead of silent approve no-op. |
| T3 | F4 | `pipeline.failedAt` (t() interpolation) + failed stage name surfaced in the failure screen. |

## Route / checks
- Route: feature branch from local develop → 3 conventional commits → PR into develop (push on authorisation).
- Checks: vitest (touched + full suite), typecheck, lint.
- TDD: ON — RED before implementation for T1, T2 and T3.
