# video-studio

Personal tool that generates videos from articles (URL or plain text).

Pipeline, in two phases:

1. **Draft:** an article goes to a local Ollama model, which writes a JSON scene script (*escaleta*). A human reviews and edits it.
2. **Approve:** Piper TTS (Wyoming protocol) narrates each scene; ComfyUI (Wan2.2 T2V/I2V) generates a still per scene plus I2V transitions between stills, sized to the narration; ffmpeg assembles the final video.

An optional standalone **PipelineAgent** (`backend/src/pipeline/agent.ts`) is the dynamic alternative to the static workflow builder: it runs Ollama tool-calling (`submit_workflow`) with a system prompt that encodes the Wan2.2 know-how, and is not wired to the orchestrator yet.

This project is a recreation of a previous repo that was lost (searched on 2026-10-04: not found); the spec comes from the Atlas note `Proyectos/video-studio`. The repo was recreated on 2026-10-04 and lives at this path; remote: `FelipePepe/video-studio` (private).

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
pnpm -r test        # 230 backend (node:test) / 120 frontend (Vitest)
pnpm -r typecheck
pnpm --filter @video-studio/backend dev   # backend :3001
```

## API

- `POST /api/pipeline/draft` — Ollama escaleta (no TTS yet)
- `PUT /api/pipeline/draft/:id/segments` — human review / editing
- `POST /api/pipeline/draft/:id/approve` — TTS + ComfyUI + ffmpeg, SSE progress
- `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE), `POST /api/jobs/:id/cancel`, `GET /api/jobs/:id/output`
- `GET/PATCH /api/config` — ComfyUI / Ollama / Piper hosts

## Workflow

GitFlow: `main` / `develop` / `feature/*`. Direct commits to `main` and `develop` are blocked by lefthook. Conventional commits only.

## Status

Core pipeline, editorial review, job infra and frontend are complete (phases 1–5 done 2026-10-04); PR chain stacked over `develop`. Not yet verified end to end against real ComfyUI (single-frame T2V assumption). See `odd/tasks/video-studio-rebuild.md` for the task list and progress.
