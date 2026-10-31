# presentadores-fase3-4 — presenters on screen (volume-driven mouths)

Branch: `feature/presentadores-fase3-4` (from `feature/presentadores-fase1-2`, PR #76 still open).
Approved plan: `~/.claude/plans/sparkling-baking-bee.md`. Briefs: `odd/tasks/presentadores/T10..T16*.md`.
Last updated: 2026-10-31.

## Objective
Two original felt-puppet presenters (A/B, from the dialogue `speaker` of phase 2) appear bottom-left / bottom-right over the video, with the mouth driven by the TTS volume. Lip-sync with a model (phase 3B) is a later, separate decision.

## Constraints
- Implementation by `pi` (qwen3.8:256k) from a brief per task; Claude reviews the diff, runs tests, commits (conventional commits, no AI attribution).
- Remote work on the Spark (192.168.1.60) beyond the project's HTTP pipeline (ComfyUI / Ollama / Piper) needs explicit user authorization. Phase 3B (download ~42 GB of models by SSH, InfiniteTalk spike) is BLOCKED on that.
- Characters: original, no "Muppet" and no Disney character names in prompts.
- TDD: on (existing project practice); runner `cd backend && node --test --import tsx test/<file>.test.ts`, frontend `pnpm vitest run`.

## Tasks
- [x] T10 audio envelope -> mouth states + presenter timelines — `193afcd`
- [x] T10b per-clip normalisation (thresholds 0.22 / 0.8 of p95, tuned on real Piper audio) — `193afcd`
- [x] T11 sprites with jaw drop + concat list + alpha clip — `5a0c05f`
- [x] T11b clip frame-exact (`-frames:v`) — `5a0c05f`
- [x] T12 overlay A bottom-left / B bottom-right, one x264 pass — `516b539`
- [x] T11c sprite crop to the character box, key defaults 0.06 / 0.02 — `edd02f2`
- [x] T15a character analysis (key colour from the corner pixel + bbox via cropdetect) — 23 tests green, typecheck green
- [x] T13 approve option `presenters: { mode: 'volume', a, b }` (character ids) — tests in bgMusic.test.ts green, typecheck green
- [x] T14 orchestrator stage `presenters` (overlay on video.mp4 inside assemble, cumulative-rounded bounds) — 11 new tests green, typecheck green
- [x] T15 character store + routes (/api/characters, migration v4, createPresenterAssets) — 19 new tests, backend 553 green, typecheck green
- [x] T16 UI (PresenterSetup + render option + presenters stage, ES/EN) — frontend 265 green, typecheck green; usePipeline/ProgressStages tests written without a captured RED run
- [ ] Real render with presenters, ffprobe, frame check, browser check of the UI
- [ ] PR to `develop`
- [ ] 3B lip-sync spike — BLOCKED (needs user authorization for destination, operation, credential)

## Evidence and decisions
- One image per character; mouth = lower jaw dropped by ffmpeg (closed 0 / mid 0.5 / open 1 of `drop`), a darkened copy of the image shows through the gap as the mouth interior. Three separate generations would not keep identity.
- Real run on three scenes of the last render: composition, voices and audio sync work; presenters were tiny because the character fills ~1/3 of the generated image -> crop to bbox (T11c/T15a).
- Chroma key: ComfyUI's "green" is not #00FF00 (0x1e941b, 0x70dd48). The key colour must be sampled from the image corner; `chromakey` similarity 0.06 / blend 0.02 keeps eyes, nose and green lashes, 0.22 destroys them.
- concat-demuxer clips are not frame-exact (230 or 214 frames instead of 221): always pass `-frames:v`.
- Mouth thresholds are relative to each clip's p95 RMS; absolute thresholds leave the mouth open 50-74 % of the frames.
- Frame boundaries per scene must come from cumulative seconds (`round(cumSec * fps)`), because the 2.0625 s inter-scene gap is 49.5 frames at 24 fps.
- Options carry character ids, not paths (server resolves from its store): no path confinement needed.

## Next step
Review T15a when `pi` finishes, commit, launch T13; then write briefs T14, T15, T16.

## Verification (per plan)
`pnpm typecheck` + `pnpm test` green after each task; real short job with `presenters` against the Spark by HTTP (3 scenes, `useLightx2v`, `vertical`); `ffprobe`; frame check that the active presenter follows the speaker; browser check (Playwright) of the setup UI.
