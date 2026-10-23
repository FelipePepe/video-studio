# pipeline-resume

**Status:** implemented, PR pending · **Updated:** 2026-10-24
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/` · **Branch:** `feature/pipeline-resume` (stacked on PR #50 progress bar + PR #51 delete-job)
**Engram mirror:** `odd/pipeline-resume/tasks` — PENDING (mem_save refused: project_transition_conflict personal vs video-studio; awaiting user project choice)

## Objective
Do not lose pipeline work (draft, review, running render) when the user switches tabs or reloads, and let a job opened from the Jobs tab show up in the Pipeline tab (live progress if running, video if done).

## Problem
`usePipeline` lives inside `PipelinePage`; `App` unmounts it on `#trabajos`, whose cleanup aborts the SSE and drops all state while the job keeps running server-side.

## Scope
- Lift `usePipeline` to `App`; restore from localStorage after reload; `openJob(jobId)` from the Jobs page.
- Out of scope: backend changes (`GET /api/jobs/:id`, `GET /api/pipeline/draft/:id`, `GET /api/jobs/:id/events` already replay + follow).

## Constraints
TDD ON (source: inherited from video-studio-rebuild; runner: `vitest run` frontend). Conventional commits, no AI attribution, never build after changes, delivery via PR into `develop` (stacked on #50/#51).

## Route declaration
Inline (frontend only, ~5 files; mapping done inline in 3 reads). No delegation: tasks are sequentially coupled through `usePipeline`.

## Tasks
- [x] **T1** API client: `watchJob(id, {onEvent, signal})` on `/api/jobs/:id/events`, SSE helper shared with `approveDraft`; fakeApi + client test.
- [x] **T2** Hook: `follow()` extracted from `approve`, `openJob(jobId)`, localStorage persistence (`vs.pipeline`) + restore on mount; hook tests.
- [x] **T3** Lift state: `App` owns `usePipeline` (inside I18nProvider via AppShell), `PipelinePage` receives it and stays mounted-but-hidden so ReviewPanel/PipelineForm local state survives too; `onOpen` wiring; App-level tab-switch test.
- [x] **T4** Jobs UI: "Open in pipeline" button on every row (`jobs.open` i18n); test.

## Acceptance
Switching tabs mid-render keeps progress; reload resumes; opening a done job shows the video; failed job shows review panel with error. `pnpm test` + `pnpm typecheck` green.

## Progress / evidence
- T1 `b76defc` · T2 `88fdd7f` · T3 `b554c2b` · T4 `75d5a4f` (each test-first: RED observed, then GREEN).
- Checks at T4: `pnpm --filter @video-studio/frontend test` 191 pass; `pnpm typecheck` OK (backend untouched).
- Deviation from the approved plan: T3 also keeps PipelinePage mounted-but-hidden (not only lifting the hook) because ReviewPanel/PipelineForm hold unsaved local state that a plain lift would still lose.
- Route per task: inline (coupled through usePipeline); no delegation trigger fired. TDD ON, runner vitest.
- Review assessment: not run on these commits (not requested; native review only ran on the earlier delete-job candidate).

## Next step
Deliver (PR into develop, stacked on #50 and #51).
