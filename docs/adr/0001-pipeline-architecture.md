# ADR — video-studio: article-to-video pipeline architecture

- **Status:** Approved (recreated 2026-10-04; re-validated 2026-10-18 against the code graph)
- **Scope:** Backend pipeline, frontend app, service boundaries
- **Evidence:** codebase-memory graph (`mnt-nas-sources-ai-tools-video-studio`, 1298 nodes / 3819 edges) + repo sources cited below

## Context

video-studio is a personal homelab tool: given an article (URL or text), it produces a narrated video.
Every dependency runs on local infrastructure:

| Concern | Technology |
|---|---|
| Script (escaleta) | Ollama (local LLM, JSON output) |
| Narration | Piper TTS over Wyoming protocol (`tcp://…` per voice) |
| Imagery | ComfyUI + Wan2.2 (T2V stills, I2V transitions) via WanVideoWrapper |
| Assembly | ffmpeg (concat, ken-burns, A/V mux, music mix, subtitles, vertical crop, cover) |
| State | SQLite via `node:sqlite` |
| UI | React 18 + Vite 5 + TypeScript (ES/EN i18n) |

The repo was recreated 2026-10-04 from the Atlas spec `Proyectos/video-studio` (the original was lost).
This ADR ratifies the architecture the rebuilt code actually implements, so future changes have a single
reference for *why* it is shaped this way.

## Decisions

### D1 — Human-in-the-loop, two-phase pipeline

The pipeline is split at a human gate:

1. **Draft** — `POST /api/pipeline/draft` sends the article to Ollama and returns a JSON escaleta
   (scenes: title / narration / visualPrompt / voice). State: `backend/src/pipeline/` draft repository.
2. **Review** — the human edits, reorders, adds or deletes scenes in the UI (`SegmentEditor`).
3. **Approve** — `POST /api/pipeline/draft/:id/approve` runs the generation as a *job*.

**Why:** generation quality from local models is non-deterministic and expensive (ComfyUI renders).
A human gate on the script is the cheapest quality control in the system; it also means the expensive
phase only runs on content that is already right.
**Consequence:** drafts are first-class persisted rows (not transient request state); approve is
**one-shot per draft** — re-approving an already-approved draft is rejected (test: *"approve returns
404 for an unknown draft and 409 when already approved"*), so a draft can never silently re-render.

### D2 — Static, stage-sequenced orchestrator (chosen)

Approve executes a **hard-wired stage sequence** in
`backend/src/pipeline/orchestrator.ts` (`createExecute`):

```
tts → images (T2V per scene) → transitions (I2V between stills) → assemble
```

Each stage is a `step()` with guard/fail/abort semantics; ffmpeg work is factored into **pure argument
builders** in `backend/src/media/ffmpeg.ts` (`concatArgs`, `musicMixArgs`, `burnSubtitlesArgs`,
`verticalCropArgs`, `coverArgs`, …), so the shell layer is testable without a GPU. Approve options
are a **strict validated allowlist** — `music` (must be an existing server file), `musicVolume`
∈ (0,1], booleans `subtitles`/`vertical`; unknown keys are rejected (`parseApproveOptions`,
`ApproveOptionsError`) so the render contract cannot silently drift.

**Why:** the stage set is known and small; a static sequence is deterministic, cancellable
(`interruptOnce`), resume-observable (per-stage progress over SSE) and trivially testable (148 frontend
+ 230 backend tests cover the seams). The single-frame T2V assumption is the current known risk (see
non-goals).
**Rejected alternative:** LLM-driven workflow selection at approve time (see D6) — kept available, not
enabled.

### D3 — Services behind thin clients with runtime config

External systems are wrapped in clients (`backend/src/clients/comfy.ts` ComfyClient, Piper/Wyoming,
Ollama fetch) with **hosts resolved at runtime** from persisted settings
(`backend/src/config/settings.ts` → `resolveEffectiveConfig`: env defaults → user overrides), editable
from the Settings modal (`GET/PATCH /api/config`). Secrets are never hardcoded; hosts are validated
(`validateHostUrl`, `validatePiperHost`).

**Why:** homelab endpoints change (IPs, ports); a personal tool must not need a redeploy to point at
another box, and the config is a small auditable surface.

### D4 — Jobs as the source of progress and artifacts

Approve creates a job row (`backend/src/jobs/jobRepository.ts`); progress and lifecycle events stream
over **SSE** (`GET /api/jobs/:id/events`; the first event is a `queued` stage carrying the `jobId`,
and clients can reconnect — `streamJobEvents`), and artifacts (final video, vertical variant, cover) are
served from the job directory (`GET /api/jobs/:id/output`). The frontend polls the Jobs list while any
job is active (`JobsPage`, 5 s interval) and keeps per-draft progress in `usePipeline`.

**Why:** generation outlives any HTTP request (minutes on a GPU); a durable job + event stream is the
minimal architecture that survives page reloads and lets a second tab observe a running render.
**Consequence:** the app is stateless per-page: refresh-safe, multi-tab-safe, cancel-safe
(`POST /api/jobs/:id/cancel`).

### D5 — PipelineAgent kept as an optional dynamic path (unwired)

`backend/src/pipeline/agent.ts` (`PipelineAgent`, `AgentMode: t2v | i2v`) encodes the Wan2.2 know-how
as an Ollama tool-calling prompt (`submit_workflow`) and can plan and run workflows on its own.
**It has zero callers in the production path** (verified in the call graph) — it is a standalone
capability, deliberately not behind any route.

**Why:** the static orchestrator (D2) is preferred until LLM-planned workflows prove more reliable;
keeping the agent unwired costs nothing (no route, no config) and preserves the option. Any future
wiring must expose it as an explicit per-job mode, not a replacement.

### D6 — Frontend: single SPA, hash views, framework-free CSS

One Vite React SPA (`frontend/src`) with two hash views (`#pipeline`, `#trabajos`), one shared i18n
provider (ES/EN), and a single global stylesheet tokenised
(`frontend/src/styles.css`; direction sheet in `.taste-skill/direction.json`). No router library, no
component framework CSS — the app is a tool, its surface is two pages and one dialog.

**Why:** matching the scope. A router/Redux/feature-slice stack would be ceremony for a five-component
app; the hash views make the whole app refresh-safe and zero-config on any static host.

## Consequences

- A GPU outage fails loudly at a named stage (TTS / images / transitions / assemble) and the job stays
  inspectable; a draft never silently re-renders.
- Adding a stage (e.g. per-scene music) touches exactly one `step()` and one argument builder.
- The known risk is model-side, not architecture-side: Wan2.2 single-frame T2V behaviour is assumed
  (see README "Status"); the orchestrator's stage isolation is what makes that assumption testable.
- Secrets discipline: only host URLs are persisted; no API keys in the config surface (local services).

## Non-goals

- Multi-tenancy, auth, or a public deployment (personal tool).
- Queue/worker separation (single-process; a job at a time is sufficient at this scale).
- Automatic quality scoring of the output; the human review gate is the quality mechanism.
