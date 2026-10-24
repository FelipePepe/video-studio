# video-studio — Improvement and Optimization Plan

- **Date:** 2026-10-21
- **Base:** `develop` @ `cf09982` (after PR #40)
- **Source:** full read-only review of `backend/src` and `frontend/src` (two independent reviewers) plus manual verification of the critical findings.
- **Status:** proposal. Nothing in this document is implemented. Every work package needs approval before code changes.

## 1. How to read this plan

**Evidence levels** (column `Ev.`):

| Level | Meaning |
|---|---|
| **V** | Verified by reading the cited code in this session. |
| **R** | Reported by a reviewer from reading the code; not re-checked by hand. |
| **H** | Hypothesis. Needs measurement or a real-service check before any change. |

**Effort:** S (< ~100 changed lines), M (~100–400), L (> 400, must be split).
**Priority:** P0 = fix first (data loss, crash, broken core flow), P1 = high value, P2 = medium, P3 = low or opportunistic.

Line numbers come from the review and may drift; re-locate by symbol before editing.

## 2. Findings catalogue

### 2.1 Functional bugs

| ID | Pri | Eff | Ev. | Finding | Where |
|---|---|---|---|---|---|
| F1 | P0 | S | V | After a job reaches `done` a new video cannot be started: `createDraft` returns silently unless state is `idle`, and `reset()` is only reachable from `ReviewPanel`, which is not mounted in `done`. | `frontend/src/hooks/usePipeline.ts:91`, `components/PipelinePage.tsx` |
| F2 | P0 | S | V | With background music enabled the `<select>` renders the first track but `musicPath` is `''`, so Approve finds no track and returns without feedback. | `components/ReviewPanel.tsx:74,104-106,137` |
| X1 | P0 | M | V | After a failed render the UI offers edit-and-reapprove, but `updateEscaleta` only updates drafts with `status='draft'`; saving returns 409. Existing test fakes never return 409. | `backend/src/pipeline/draftRepository.ts:74-78`, `routes/pipeline.ts:147`, `PipelinePage.tsx:25`, `ReviewPanel.tsx:101` |
| F3 | P1 | M | R | Switching to the "Trabajos" view unmounts `PipelinePage`, destroying the draft, unsaved edits and progress view while the job keeps running. `getDraft` exists in the API client but is unused. | `App.tsx:49`, `usePipeline.ts:75-82` |
| F4 | P1 | S | R | `ProgressStages` (failed branch) and `VideoPanel state==='failed'` are unreachable: in `failed` a draft always exists, so `ReviewPanel` renders and the failed stage is never shown. | `PipelinePage.tsx:19,25`, `VideoPanel.tsx:28-39` |
| F5 | P1 | S | R | Music library rejects its own files when `MUSIC_DIR` is (under) a symlink: `listMusicDir` returns un-resolved paths while `parseApproveOptions` compares against `realpathSync(dir)`. Also: `rel.startsWith('..')` false-positives on `..foo.mp3`, `existsSync` accepts directories, and a symlink inside the library pointing outside passes. | `backend/src/routes/pipeline.ts:42-48`, `lib/musicLibrary.ts:45` |
| F6 | P1 | M | R | Transition failures are swallowed: any error (ComfyUI down, 1 h timeout, disk) becomes a hard cut, the job ends `done`, and the only trace is an ephemeral SSE event. | `backend/src/pipeline/orchestrator.ts:259-263` |
| F7 | P2 | S | R | Subtitles emit one cue per scene with up to 1200 chars (`MAX_NARRATION`), not split into lines or timed chunks; a blank line (`\n\n`) in narration breaks SRT. | `orchestrator.ts:340`, `pipeline/subtitles.ts:41-60`, `pipeline/draft.ts:43` |
| F8 | P2 | M | R | Retry from the Jobs list: no `AbortController` (stream stays open), the 6 s timeout rejects while the request continues (job may still be created), and re-approval sends no body so `music`, `musicVolume`, `subtitles`, `vertical` of the original job are lost. `Job.options` exists in the backend type but not in `api/types.ts`. | `frontend/src/components/JobsPage.tsx:84-107`, `api/types.ts:39-51`, `backend/src/jobs/types.ts:12-13` |
| F9 | P2 | S | R | `cancel()` has `try/finally` without `catch`: 409/network errors become unhandled rejections and the list is not refreshed. | `JobsPage.tsx:69-77` |
| F10 | P2 | S | R | "Back" from review loses the URL/text typed in `PipelineForm` (local state unmounted). | `PipelinePage.tsx:25-28`, `PipelineForm.tsx:18-24` |
| F11 | P2 | S | R | Ollama model `<select>` has no empty option and may not contain the stored value, so the UI shows a model that is not actually configured. | `SettingsModal.tsx:154-163` |
| F12 | P3 | S | R | `listVoices` ignores all but the first event per chunk (second event waits for the 60 s timeout) and only accepts `type==='describe'`; real Wyoming servers answer `describe` with `info` (voices in `tts[].voices`). The test fake repeats the same assumption. | `backend/src/clients/piper.ts:184-219`, `test/voices.test.ts:36-46` |

### 2.2 Robustness and resource handling (backend)

| ID | Pri | Eff | Ev. | Finding | Where |
|---|---|---|---|---|---|
| B1 | P0 | S | V | `downloadToFile` attaches the writer `error` listener only after the write loop. A write error mid-download (disk full, directory pruned, EIO) is an unhandled `error` event → `uncaughtException`; `server.ts` only handles `unhandledRejection`, so the process dies. The `drain` wait can also never resolve after a failure. | `backend/src/clients/comfy.ts:309-326`, `server.ts:33` |
| B2 | P0 | S | V | `interrupt()` posts to `/interrupt` without `prompt_id`; cancelling a job interrupts whatever ComfyUI is running, including other clients' work on the shared server, even if the job was in TTS/ffmpeg. | `comfy.ts:333`, `orchestrator.ts:384-390` |
| B3 | P1 | S | R | `waitForCompletion` takes no `signal`; after cancel it relies on `/history` flipping to error. If ComfyUI restarts, `/history/<id>` is empty and the loop polls for up to 1 h without checking `/queue`. `elapsed` sums only `intervalMs`, so the real timeout is longer than configured. | `comfy.ts:237-266`, `orchestrator.ts:195,252` |
| B4 | P1 | S | R | Ollama calls have no timeout or abort (`listModels`, `chatJson`); client disconnects do not cancel the upstream request; no concurrency limit on `/draft`. | `clients/ollama.ts:26-61`, `pipeline/draft.ts:123`, `routes/pipeline.ts:79-100` |
| B5 | P1 | M | R | No graceful shutdown: no SIGTERM/SIGINT handler, no `server.close`, no abort of the running job (ffmpeg may be orphaned, ComfyUI keeps rendering), no `db.close`, no `error` handler on `listen`. | `server.ts:18-22` |
| B6 | P2 | S | R | ffmpeg has no watchdog timeout; a hung process blocks the single-job queue until abort. SIGKILL leaves partial output files. | `media/ffmpeg.ts:11-36` |
| B7 | P2 | S | R | `escapeFilterPath` escapes only `\` and `:`; paths with `'`, `,`, `;`, `[`, `]` break the `subtitles=` filtergraph. | `media/ffmpeg.ts:154-170` |
| B8 | P2 | M | R | Disk growth: `pruneWorkDirs` runs only at `start()`; `data/cache` has no retention. | `jobs/runner.ts:61-72`, `pipeline/contentCache.ts:13` |
| B9 | P2 | M | R | Content cache is not atomic (`writeFileSync` straight to the final path), so a truncated file is reported as a hit forever. Whole mp4 files are read into memory just to copy them (blocks the event loop). Seed depends on `draftId`, contradicting the "portable across jobs" comment. | `contentCache.ts:45`, `orchestrator.ts:181,199,234,258` |
| B10 | P3 | S | R | Errors leak internals: `/draft` returns `e.message` with 502 for any failure; ffmpeg stderr tails and ComfyUI bodies reach SSE and `markFailed`. | `routes/pipeline.ts:98`, `runner.ts:178-181` |
| B11 | P3 | S | R | `parseWav` and `wavDurationSec` parse the same buffer twice; TTS WAVs are held fully in memory. | `orchestrator.ts:151-152` |
| B12 | P3 | S | R | No indexes on `jobs(draft_id, created_at)` / `jobs(status, created_at)`; ad-hoc migrations via `PRAGMA table_info` instead of `user_version`; `schema.sql` is read via `__dirname` (breaks a plain `tsc` build). | `db/schema.sql`, `db/connection.ts:8-61` |

### 2.3 Performance

| ID | Pri | Eff | Ev. | Finding | Where |
|---|---|---|---|---|---|
| P1 | P1 | S | R | `burnSubtitlesArgs` and `verticalCropArgs` set no `-preset` (x264 default `medium`) while other encodes use `veryfast`; vertical+subtitles can mean 3 x264 encodes. Target: `veryfast`/`fast` and a single chained `crop,scale,subtitles` pass for vertical. | `media/ffmpeg.ts:159-181`, `orchestrator.ts:341,352-353` |
| P2 | P1 | M | R | Pipeline is fully sequential: Ken Burns clips (CPU) do not depend on transitions (GPU) yet wait for them; prompts are submitted and polled one at a time (2 s poll), leaving GPU gaps. Pre-queue prompts and overlap Ken Burns with the transitions stage. | `orchestrator.ts:474-477` |
| P3 | P2 | S | R | One SQLite `UPDATE` (plus a `SELECT` via `patchJob`) per ComfyUI sampling tick even when `progress` is unchanged; these events also fill the 200-event replay buffer and evict `stage` events, so reconnecting clients lose context. | `jobs/runner.ts:157-163`, `orchestrator.ts:408-417`, `jobs/eventHub.ts:30` |
| P4 | P3 | S | R | Cover extraction places `-ss` after `-i` (decodes up to the seek point). Move before `-i`. | `media/ffmpeg.ts:184-187` |
| P5 | P3 | H | H | Possible A/V drift: Ken Burns clips are frame-quantized at 24 fps while audio/subtitles use exact durations; up to ~0.5 s accumulated over 12+ scenes. **Measure with `ffprobe` before acting.** | `ffmpeg.ts:64`, `orchestrator.ts:289` |
| P6 | P3 | S | R | Frontend polling in Jobs runs while the tab is hidden; `load` depends on `t`, so a language change restarts the interval. | `JobsPage.tsx:63-67` |

### 2.4 Security (relevant if the service leaves localhost/intranet)

| ID | Pri | Eff | Ev. | Finding | Where |
|---|---|---|---|---|---|
| S1 | P2 | S | R | `GET /draft/:id/publish` runs an LLM call per request, uncached and outside the token guard (guard covers only POST/PUT/PATCH/DELETE). Same exposure for `GET /voices`, `/ollama/models` and SSE. | `routes/pipeline.ts:112`, `config/auth.ts:27` |
| S2 | P2 | S | R | No `Host` header validation (DNS rebinding) and no warning when binding non-loopback without `API_TOKEN`. `PATCH /api/config` accepts arbitrary http(s)/`tcp://` targets (SSRF-style); article fetch follows redirects to internal hosts (documented decision, should be restated next to this). | `app.ts:60-75`, `routes/config.ts`, `config/settings.ts:35`, `pipeline/article.ts:89` |
| S3 | P3 | S | R | Minor hardening: no rate limiting, `x-powered-by` enabled, SSE backpressure ignored (`res.write` unchecked), no per-job SSE connection cap. | `config/auth.ts`, `app.ts`, `routes/jobs.ts:29` |

### 2.5 UX, accessibility, i18n (frontend)

| ID | Pri | Eff | Ev. | Finding | Where |
|---|---|---|---|---|---|
| U1 | P2 | M | R | SSE stream cut (network/proxy) marks the pipeline `failed` even though the job continues. Reconnect to `/api/jobs/:id/events` (replay) or poll `getJob`, with bounded backoff, before failing. | `usePipeline.ts:212-229`, `api/client.ts:184-209` |
| U2 | P2 | S | R | Focus trap is incomplete: `FOCUSABLE` omits `select`/`textarea`; `ConfirmDialog` has no Tab trap; background is not `inert`. Extract a `useFocusTrap` hook or use `<dialog>.showModal()`. | `SettingsModal.tsx:17`, `ReviewPanel.tsx:249-274` |
| U3 | P2 | S | R | Jobs filter group is labelled with `nav.label` ("main navigation"). | `JobsPage.tsx:126` |
| U4 | P2 | S | R | Google Fonts loaded from an external CDN on an intranet app (render-blocking CSS, layout shift offline). Self-host via `@fontsource`. | `frontend/index.html:7-10` |
| U5 | P3 | S | R | i18n gaps: backend messages shown raw (`ApiError.message`, `Job.error`, `job.stage`, SSE warnings); English default in `client.ts:108`; `document.documentElement.lang` never updated; hardcoded `ES`/`EN` and `qwen3:8b` placeholder. | `client.ts:108`, `JobsPage.tsx:179,186`, `PipelineForm.tsx:76-77`, `SettingsModal.tsx:170`, `index.html:2`, `i18n.tsx` |
| U6 | P3 | S | R | No `aria-live` for stage changes/failure; `progressbar` in Jobs unlabeled; music-volume slider lacks `aria-valuetext`. | `ProgressStages.tsx:34-57`, `JobsPage.tsx:180`, `ReviewPanel.tsx:153-161` |
| U7 | P3 | S | R | Unstable effect dependencies: inline `onClose` re-registers the `keydown` listener every render; `log.child('jobs')` recreated per render with `eslint-disable` (no ESLint is configured, so the disables are decorative). | `SettingsModal.tsx:58-64`, `App.tsx:51`, `usePipeline.ts:45` |
| U8 | P3 | M | R | Scene list re-renders fully per keystroke; `key={index}` reuses DOM nodes on reorder/delete. Give scenes stable client ids and memoize a `SceneCard` (max 20 scenes, so low priority). | `SegmentEditor.tsx:78-146`, `ReviewPanel.tsx:88-89` |
| U9 | P3 | M | R | Types: API responses cast with `as T`, SSE frames cast to `JobEvent` without a guard, `Voice` collapses to `string`, `JobEvent.at` optional in the frontend but required in the backend. Add `isJobEvent` and align `Job`/`JobEvent`. | `api/client.ts:137,200`, `api/types.ts:11` |

### 2.5b Visual UX (live browser review, 2026-10-21)

Method: headless Chromium against the dev servers (backend :3001 with a throwaway SQLite DB, Vite :5173), desktop 1280 px and mobile 390 px, ES locale, light scheme. External services were replaced by dead local ports plus a local fake Ollama, so no LAN host was contacted. Not covered: real ComfyUI/Piper runs, the live progress view, the Jobs list with data, dark mode, keyboard-focus visibility.

Observed with no JavaScript errors in the console (only a `favicon.ico` 404).

| ID | Pri | Eff | Ev. | Finding | Where |
|---|---|---|---|---|---|
| V1 | P2 | S | V | Mobile: Voice A/B selects are squeezed next to the "Mix" button and truncate their values ("Masculi", "Femeni"). Let the voice row wrap or stack below ~480 px. | `frontend/src/styles.css`, `PipelineForm.tsx` |
| V2 | P2 | S | V | Mobile: the sidebar collapses into a header where nav links, Settings and the ES/EN toggle stack in two misaligned rows. Give the header a deliberate compact layout (single row nav, toggle and Settings grouped). | `styles.css`, `Sidebar.tsx` |
| V3 | P2 | S | V | "Generate" is disabled and greyed with no hint of what is missing (URL or text). Add helper text or inline validation. | `PipelineForm.tsx:27` |
| V4 | P1 | S | V | Failure presentation: after a TTS failure the review screen shows only a small raw red line in English (`tts failed for scene 1: Piper unreachable at tcp://127.0.0.1:9: connect ECONNREFUSED ...`), with no failed stage and no recommended next step. Confirms F4 and U5. Fold into WP1 (F4) and WP11 (i18n mapping). | `ReviewPanel.tsx`, `PipelinePage.tsx` |
| V5 | P3 | S | V | Jobs empty state is a single line with a default-blue "Pipeline" link that does not match the palette; no icon or call to action. | `JobsPage.tsx`, `styles.css` |
| V6 | P3 | S | V | "Settings" in the sidebar has no button affordance (no fill or border), unlike the other controls. The right-hand "The video will appear here" placeholder takes half the width without offering content or guidance. | `Sidebar.tsx`, `VideoPanel.tsx`, `styles.css` |
| V7 | P3 | S | V | `favicon.ico` returns 404. Add a favicon (also removes the console error). | `frontend/index.html`, `frontend/public/` |

Live confirmations of earlier findings:

- **X1 reproduced:** `PUT /api/pipeline/draft/:id/segments` on an already-approved draft returns `409 "Draft <id> is already approved"`, so the "edit and re-approve" path shown after a failure cannot save.
- **F4 reproduced:** the failed stage is not visible anywhere on the failure screen (see V4).
- **Settings dialog:** loads correctly (the transient "Loading settings…" seen in one capture was only the pre-fetch state; endpoints answered in ~3 ms), so no issue was raised.
- **Source toggle semantics:** URL/Text is a button group with `aria-pressed` rather than tabs; this is valid and needs no change.

### 2.6 Structure and maintainability

| ID | Pri | Eff | Ev. | Finding |
|---|---|---|---|---|
| M1 | P3 | M | R | `piper.ts`: `synthesize` and `listVoices` duplicate Wyoming framing, settle logic and timeouts. Extract a shared framing client (also resolves F12). |
| M2 | P3 | S | R | `app.ts` computes `musicDir` twice; orchestrator music × subtitles × vertical branches are not unified (the code comment admits it); `Shared` carries ~25 fields, which makes stages hard to test in isolation. |
| M3 | P3 | S | R | `PipelineAgent` remains unwired (documented in ADR D5). Keep, but exclude from refactors; `runner.enqueue` is only used by tests. |
| M4 | P3 | S | R | README says "pnpm 10" while `package.json` and CI pin `pnpm@12.14.0`. Atlas note `Proyectos/video-studio` last updated 2026-10-17 and stale. |

## 3. Open product decisions (block specific packages)

1. **X1 — failed-render retry semantics.**
   - **DECIDED (2026-10-21): Option B.** Allow `PUT segments` when the draft's latest job is `failed`/`cancelled`.
     - Rationale: ADR D1 already states that on failure "the editor reopens (fix the script, then approve)" and the UI offers it, so the `status='draft'` guard in the backend is the defect, not the UI; the content cache (PR #18) makes re-rendering after a single-scene edit cheap; failures can be script-caused (rejected visual prompt, oversized narration), where read-only retry would force a brand-new draft.
     - Rejected: Option A (read-only escaleta plus "Retry"). It needs no backend change but contradicts the documented D1 behavior and wastes the cache. It would only be preferable if approved scripts had to stay immutable as a render record, which a personal tool does not need.
2. **F6 — transition failure policy.** Degrade to hard cut vs. abort after N consecutive failures; whether to persist `warnings` on the job (schema change).
3. **S1/S2 — threat model.** Is the service ever reachable beyond the trusted LAN? If not, S-series drops to documentation plus the bind warning.
4. **F3 — state persistence.** Keep `PipelinePage` mounted (hidden/inert), lift `usePipeline` into `App`, or rehydrate from `sessionStorage` + `getDraft`.

## 4. Work packages (delivery slices)

Each package is one `feature/*` branch and one PR into `develop`, with tests alongside behavior and a Conventional Commit message. Target ≤ ~400 authored changed lines per PR; split if exceeded. Proposed order follows risk and dependency.

### WP1 — Frontend core flow fixes (P0) · F1, F2, F4
- **F1:** "New video" button in `done` and `failed` calling `reset()`; form `disabled` whenever state ≠ `idle`.
- **F2:** initialize `musicPath` to the first library track when the library loads or the switch is enabled; replace silent `return` with a validation message (new i18n key ES/EN).
- **F4:** show the failed stage (reuse `ProgressStages` or a summary) inside the review branch; remove the dead `VideoPanel` failed state if unused.
- **Tests (RED first):** `PipelinePage` second draft after `done`; `ReviewPanel` approve with default track; failed stage visible on `failed`.
- **Risk:** low. **Depends on:** none.

### WP2 — Backend crash and cancellation safety (P0/P1) · B1, B2, B3
- **B1:** `pipeline(Readable.fromWeb(res.body), createWriteStream(dest))`; delete the partial file on failure; add `process.on('uncaughtException')` that logs and exits in a controlled way.
- **B2:** send `{ prompt_id }` to `/interrupt`; call it only when the job has an in-flight prompt of its own. Verify against the ComfyUI version on babybeast before relying on the parameter (**H** until checked).
- **B3:** pass `signal` into `waitForCompletion`, check it every iteration, use `Date.now()` for the timeout, and when history stays empty N consecutive polls consult `/queue` and fail if the prompt is absent.
- **Tests:** disk-error mid-download (fake writer emitting `error`), cancel during wait, empty-history persistence, `/interrupt` body.
- **Risk:** medium (touches the render path). **Depends on:** none.

### WP3 — Failed-render retry flow (P0) · X1 (+F8, F9)
- **Backend (Option B, per §3.1):** in `draftRepository.updateEscaleta` and `routes/pipeline.ts`, allow the update when `status='draft'` **or** the draft's latest job is `failed`/`cancelled` (the same condition the approve-retry already uses); keep 409 when the latest job is `queued`, `running` or `done`.
- **ADR:** amend D1 in the same PR to state that "one-shot" approve admits script edits after a `failed`/`cancelled` job.
- **Frontend:** keep the edit/save/re-approve flow shown after a failure; map any remaining 409 from `saveSegments` to an i18n message.
- **F8:** add `options` to the `Job` type, send it as the retry body, add `AbortController` (abort after first event and on unmount), remove the false-failure timeout path.
- **F9:** `catch` in `cancel()` with an i18n error and always refresh.
- **Tests (RED first):**
  - Backend: edit after `failed` → 200; edit after `cancelled` → 200; edit with a `queued`/`running`/`done` latest job → 409; edit of a draft with no job still works.
  - Frontend: fake API that returns 409 for the blocked cases; retry preserves options; cancel failure surfaces an error.
- **Risk:** low-medium (touches the draft lifecycle but reuses the existing retry condition).
- **Depends on:** none (decision §3.1 is closed). WP1 F4 should land first so the failed stage is visible before the editor reopens.

### WP4 — Music library correctness (P1) · F5
- Resolve both sides with `realpathSync`, require `isFile()`, fix the `..` prefix check (`rel === '..' || rel.startsWith('..' + sep)`), store the resolved path.
- **Tests:** symlinked `MUSIC_DIR`, symlink escaping the library, directory path, file named `..foo.mp3`.
- **Depends on:** none.

### WP5 — Transition failure handling (P1) · F6
- Distinguish rejected/failed execution (degrade) from unreachable/timeout (abort after N consecutive failures); persist `warnings` on the job and surface them in Jobs.
- **Depends on:** decision §3.2; may need a schema migration (coordinate with WP9).

### WP6 — Render performance (P1/P2) · P1, P2, P3, P4
- Presets and chained vertical filter (P1). Verify output with `ffprobe` and compare wall-clock before/after on a fixed fixture.
- Overlap Ken Burns with transitions; pre-queue ComfyUI prompts (P2). Split into its own PR; highest regression risk in the plan.
- Throttle/skip redundant progress persistence and keep `stage` events out of the replay eviction path (P3).
- Move `-ss` before `-i` (P4).
- **Acceptance:** no change in output duration/streams; measured render time reduction recorded in the PR.
- **Depends on:** WP2 (cancellation semantics must be settled first).

### WP7 — Lifecycle and disk hygiene (P1/P2) · B4, B5, B6, B8, B9
- Ollama timeouts/abort and a small concurrency limit on `/draft` (B4).
- SIGTERM/SIGINT: abort running job, close server and DB; `listen` error handler (B5).
- ffmpeg watchdog and partial-output cleanup (B6).
- Periodic prune with `unref`'d timer and TTL/LRU for `data/cache` (B8).
- Atomic cache writes (`.tmp` + `rename`), `copyFile` instead of read+write, WAV validation before caching, seed/key review (B9).
- **Likely 2 PRs** (B4+B5+B6, then B8+B9).

### WP8 — Subtitles and ffmpeg hygiene (P2) · F7, B7
- Split narration into cues by sentence/length with proportional timing; sanitize `\n\n`.
- Run ffmpeg with `cwd = workDir` and a relative subtitle path instead of escaping absolute paths.
- **Tests:** long narration, blank lines, paths with `'` `,` `[` `]`.

### WP9 — Data layer cleanup (P3) · B12 (+ schema for WP5)
- Add the two `jobs` indexes, move migrations to `PRAGMA user_version`, make `schema.sql` loading build-safe.

### WP10 — Frontend resilience (P2) · F3, F10, U1, P6
- State persistence per §3.4; keep form state; SSE reconnection with bounded backoff; pause polling when hidden and decouple `load` from `t`.

### WP11 — Accessibility, i18n, assets (P2/P3) · F11, U2–U7, U9
- Empty/current option in model select; `useFocusTrap` + inert background; filter label key; self-hosted fonts; i18n mapping of status codes and stage labels; `lang` sync; `aria-live` and labels; stable effect deps; `isJobEvent` guard and type alignment.
- Likely 2 PRs (a11y/i18n, then types/assets).

### WP11b — Visual polish (P2/P3) · V1, V2, V3, V5, V6, V7
- **V1/V2:** responsive CSS for the voice row and the mobile header; verify at 320, 390 and 768 px.
- **V3:** helper text or inline validation explaining why "Generate" is disabled (new i18n keys ES/EN).
- **V5/V6:** friendlier Jobs empty state with a palette-consistent action button; give Settings a visible control style; make the video placeholder smaller or useful (for example, a short hint or recent output).
- **V7:** add a favicon.
- **V4** is delivered by WP1 (F4, failed stage visible) and WP11 (error i18n), not here.
- **Verification:** re-run the live browser review used for §2.5b (desktop and mobile screenshots before/after) and attach both to the PR; unit tests only where behavior changes (V3 validation text).
- **Risk:** low, CSS and copy only. **Depends on:** none; best done after WP1 so screens are stable.

### WP12 — Security hardening (P2/P3) · S1, S2, S3 — scope per §3.3
- Token on `GET /publish` (or convert to POST) plus per-draft caching; `Host` allowlist; startup warning for non-loopback bind without token; `x-powered-by` off; SSE backpressure.

### WP13 — Maintainability (P3) · M1, M2, U8, B10, B11
- Shared Wyoming framing client (with F12, verified against a real Piper); orchestrator branch unification; scene ids/memoization; error mapping; WAV double parse.

### WP14 — Docs and housekeeping · M4
- Fix README pnpm version, update this plan's status, sync the Atlas note, commit `CLAUDE.md`.

## 5. Recommended execution order

1. **WP1** (quick, visible wins) → **WP2** (crash and cancel safety) → **WP4** → **WP3** (decision X1 closed: Option B).
2. **WP5** and **WP7** in parallel branches if desired (independent files except the job schema).
3. **WP6** only after WP2 is merged.
4. **WP8**, **WP10**, **WP11**, **WP11b**, **WP9**.
5. **WP12** per threat-model decision; **WP13**/**WP14** opportunistically.

## 6. Verification strategy

- **Per task:** write the failing test first where TDD applies (runner: backend `node --test --import tsx`, frontend `vitest run`), then implement, then run the package's affected tests. Project convention is to run `pnpm typecheck && pnpm test` in CI, not locally after every edit.
- **Test-gap closure** (reviewers' findings): symlink music library; mid-download write error; `waitForCompletion` with persistent empty history and with cancel; auth on expensive GETs; subtitles with long text and `\n\n`; 409 on `PUT segments` in frontend fakes; default music track in `ReviewPanel`; second video after `done`; hash navigation in `App`; focus trap; Piper contract test against a real response.
- **Real-service checks (not coverable by unit tests):** `/interrupt` with `prompt_id` on babybeast ComfyUI; Piper `describe`/`info` behavior; render-time benchmark and `ffprobe` A/V duration comparison for WP6 and P5.
- **Non-regression:** current baseline is the `develop` suite (313 tests at last recorded state, re-measure before starting); no package may reduce it.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| WP6 overlap changes ordering/cancel semantics in the orchestrator. | Land WP2 first; keep WP6 in its own PR; compare output streams and durations against a baseline render. |
| `prompt_id` support in `/interrupt` varies by ComfyUI version. | Check on babybeast; fall back to queue deletion of the own prompt. |
| X1 Option B (chosen) alters the draft lifecycle documented in ADR D1. | Reuse the existing approve-retry condition (`failed`/`cancelled` latest job); amend ADR D1 in the same PR; cover blocked states with backend tests. |
| Schema changes (WP5/WP9) on an existing SQLite file. | Use `user_version` migrations and test upgrade from the current schema. |
| Review findings marked **R** may be partly wrong. | Re-read the cited code at the start of each package; downgrade or drop findings that do not reproduce. |

## 8. Delivery rules

- GitFlow: `feature/<name>` from `develop`, PR into `develop`; never commit to `main`/`develop` (lefthook enforces it).
- Conventional commits; tests and docs travel with the behavior change.
- Record each merged package here (status column to be added when work starts) and keep `odd/tasks/<feature>.md` per substantial package.
