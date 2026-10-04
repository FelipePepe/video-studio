# video-studio

Personal tool that generates videos from articles (URL or plain text).

Pipeline, in two phases:

1. **Draft:** an article goes to a local Ollama model, which writes a JSON scene script (*escaleta*). A human reviews and edits it.
2. **Approve:** Kokoro TTS narrates each scene, ComfyUI (Wan2.2 T2V/I2V) generates the visuals, and ffmpeg assembles the final video.

This project is a recreation of a previous repo that was lost; the spec comes from the Atlas note `Proyectos/video-studio`.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite 5, TypeScript, Vitest + jsdom |
| Backend | Node.js + Express 4, TypeScript (CommonJS), `node:sqlite`, `node:test` |
| Visuals | ComfyUI + Wan2.2 via WanVideoWrapper |
| Script | Ollama |
| TTS | Kokoro |
| Assembly | ffmpeg |
| Monorepo | pnpm workspaces |

## Requirements

- Node.js >= 22.5 (for `node:sqlite`)
- pnpm 10
- ffmpeg on `PATH`
- Reachable ComfyUI, Ollama and Kokoro hosts (configurable at runtime from the Settings modal)

## Workflow

GitFlow: `main` / `develop` / `feature/*`. Direct commits to `main` and `develop` are blocked by lefthook. Conventional commits only.

## Status

Under construction. See `odd/tasks/video-studio-rebuild.md` for the task list and progress.
