# video-studio-wp1-frontend-core-flow

**Status:** done · **Branch:** `feature/wp1-frontend-core-flow` (cut from local develop @ cf09982)
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/`

**Result (2026-10-21):** 3 commits (66708a2 F1, 52cf3b5 F2, a263bec F4). Frontend 17 files / 163 tests green, typecheck green, no ESLint in repo (N/A). Live browser scenario (chromium, isolated stack 15434/3101/5199): idle form → review screen → F2 music preselect PASS (`demo.mp3` pre-selected) → approve → SSE failure → F4 alert PASS (`Falló en la etapa «Voz (TTS)»: …Piper unreachable`) with exactly 1 `<h2>`. Evidence: /tmp/vslive/evidence/{01_idle,02_review_music,03_failure}.png. F1 done-state covered by component test (live done-state needs full ComfyUI+Piper stack).

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
