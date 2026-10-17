# video-studio-enhancements

**Status:** tasks complete, PRs open (waiting on human merge) · **Updated:** 2026-10-04
**Repo:** `/mnt/nas/sources/ai-tools/video-studio/` · **Root branch:** `feature/video-studio-enhancements` (cut from `feature/video-studio-rebuild-p5`)
**Engram mirror:** `odd/video-studio-enhancements/tasks`

## Objective
Add the features the 2026-10-04 MoneyPrinter* analysis proved as table stakes, where they map onto our stack WITHOUT adding stock-asset dependencies or new external APIs: **BGM + ducking**, **burned subtitles**, **vertical 9:16 crop + cover thumb**, **Piper voices endpoint**.

## Evidence (2026-10-04, `gh api` on public repos)
- `harry0703/MoneyPrinterTurbo` (~128k★): `app/services/` contains `bgm.py`, `subtitle.py`, `material.py` (stock), `voice.py`, `video.py`, `upload_post.py`, `elevenlabs_music.py`. We adopt the first three patterns (bgm, subtitle, vertical from marketing features) and NOT stock/upload (different value proposition: editorial gate + real Wan2.2 per-scene generation).
- `ddean2009/MoneyPrinterPlus` (~7k★): ComfyUI for stills — confirms ComfyUI-per-scene is a viable production pattern.
- Our differentiators stay: human editorial review before TTS/vision, I2V transitions between stills, per-scene narration-matched timing.

## Scope
- **E1** BGM + ducking: approve accepts `music` (server path) + `musicVolume`; final mix uses `sidechaincompress` so narration stays on top.
- **E2** Burned subtitles: SRT from escaleta + assembled timeline (per-scene durations incl. transition silences); burned in final encode.
- **E3** Vertical 9:16 render + cover thumbnail; output endpoint gains a `?variant=` option (`default` | `vertical` | `cover`).
- **E4** `GET /api/voices`: Piper `describe` (Wyoming) → voice list. Frontend dropdown = follow-up, out of scope.
- Out of scope: stock assets, YouTube auto-posting, AI music generation, `visual-character-sync` (no spec).

## Constraints
Inherit from `video-studio-rebuild`: TDD ON (`node --test --import tsx` backend; `vitest run` frontend), runners as there; conventional commits, no AI attribution, commits only on feature branches; never build after changes; private-network hosts only.

## Process config
- **TDD:** ON (inherited, user choice 2026-10-04).
- **Delivery:** `feature-branch-chain` (cached user choice): root = E1; `-p1` = E2; `-p2` = E3; `-p3` = E4; PRs stacked; final root PR → `develop` only after the user merges the video-studio-rebuild chain (PR #5 is this feature's base line).
- **Authorized scope:** same as rebuild (repo writes, git, `gh pr create`); no new remote destinations.

## Forecast
~700–900 authored changed lines across 4 tasks (tests included). Under one slice per task ⇒ mostly `under_budget`/passive reviews; medium tiers handled by the native flow.

## Tasks
- [x] E1 BGM + ducking (root) — `musicMixArgs` (sidechaincompress driven by narration, amix duration=first) in `media/ffmpeg.ts`; approve body `music` (path, `existsSync` at the boundary) + `musicVolume` (0,1], unknown keys → 400; `jobs.options` (TEXT) + guarded migration in `db/connection.ts`; orchestrator takes the music branch only when present. TDD: RED 5/5 (module/behavior) → GREEN 5/5; suite 235/235; typecheck clean. **Commit `c7e63a5`** on root. Route: inline (writer trigger fired — 10 files — no subagent mechanism in this pi runtime).
- [x] E2 Burned subtitles (`-p1` branch) — `pipeline/subtitles.ts`: `buildSrt` (RFC-ish cue format, `HH:MM:SS,mmm`, validated cues) + `sceneCues` (per-scene timeline incl. the silences actually inserted between scenes); `burnSubtitlesArgs` (subtitles filter, libx264 re-encode, audio copy, path escaping for `\` and `:`); approve option `subtitles` (boolean, **default ON**; `false` keeps the classic mux tail); orchestrator: mux → `muxed.mp4` → burn → `final.mp4` (music mix keeps the same order before the burn). TDD: RED 7/7 → GREEN 7/7; suite **242/242**; typecheck clean. Commit on the E2 slice; the exact SHA is recorded in the `docs: record E2` commit body. The pre-existing orchestrator tail assertion was updated to the new default (burn at the end).
- [x] E3 Vertical 9:16 + cover thumb + `?variant=` (sobre `-p1`) — `1d8bb43` · **review `review-0f726ea3ea4be1ee` APPROVED** (advisory: doc de estado vacío `?lang=`, 503 reenvía host interno, duplicado try/catch, guard `coverArgs` sin test)
- [x] E4 `GET /api/pipeline/voices` (Piper `listVoices` + `voicesRouter`) — `95a92e1` (mismo candidato de review que E3, APPROVED)

**Corrección de rama (2026-10-04):** E3 (y E4) se implementaron sobre `-p1` (las ramas `-p2`/`-p3` proyectadas no se crearon): el candidato de review cubre E3+E4 juntos y la cadena de PRs es root → `-p1` → develop (tras merge de la cadena rebuild).

## Acceptance criteria
- `pnpm -r test` green; `pnpm -r typecheck` clean.
- E1: args-graph test (inputs, sidechaincompress, amix) + route validation (bad volume, missing file) + options persisted on the job row.
- E2: SRT builder + cue-math tests (transition offsets); final encode path exercised with a fake ffmpeg; optional local-ffmpeg integration.
- E3: crop/cover args tests + route variant behavior; default behavior (final.mp4 only) unchanged.
- E4: piper client `listVoices` against the fake Wyoming server + route shape test.

## Verification evidence
- `node --test --import tsx test/*.test.ts`: **253/253 pass** (235 base → +5 E1 → +7 E2 → +7 E3 → +4 E4; la assertion de cola del orchestrator se actualizó a la nueva salida).
- `npx tsc --noEmit` (backend): clean.
- Frontend: 120/120 (sin cambios; E1–E4 no tocan frontend).
- Candidato E3+E4: 14 paths / **468 líneas**, assessed **high** (`process_boundary` `media/ffmpeg.ts`), `review_due: true`, consent granted (user-delegado “decide tu”, 2026-10-04).
## Review assessments per task
- E1 (`c7e63a5`): range `51b3a47..c7e63a5`, risk **high** (`process_boundary`, `media/ffmpeg.ts`), 351 lines, `review_due: true` (`high_risk`). User granted consent (option 1, 2026-10-04); 4 lenses (risk/resilience/readability/reliability) — all admitted `completed` via the pi `--agent pi --materialize` + `--input` flow → **approved**; acknowledged (lineage `review-f0475591901ba9f7`, revision `9a7c7fa1…c572c`, authority **burned**). Advisory (non-blocking, separate later work): R1-001 `music` has no path allow-list (local-tool trust model — base design); R3-001 orchestrator music branch untested at execution level; R3-002 unparseable stored `options` JSON throws in `fromRow` (`jobRepository.ts:42`).

- E3+E4 (`1d8bb43`, `95a92e1`): rango `30e7ced..95a92e1`, 14 paths / 468 líneas, risk **high** (`process_boundary`, `media/ffmpeg.ts`), `review_due: true` (`high_risk`). Consent granted (delegado por el usuario, 2026-10-04); target `6cd73c94…`, candidate tree `6d95eec1…`. 4 lenses admitidos (lineage `review-0f726ea3ea4be1ee`); cierre `approved` (revision `9464c326…`), autoridad **burned**. Advisory (no bloqueantes): R1 estado de `?lang=` sin partido vs 400; R1/R4 503 reenvía el host interno de Piper; R2 try/catch duplicado en `voicesRouter`; R3 guard de `coverArgs` y filtro de crop sin test; R2 statement muerto (`void sock`) en un test.

## Slices (PRs)
Local: root `feature/video-studio-enhancements` (E1) ← `-p1` (E2+E3+E4).
Remote `FelipePepe/video-studio`: **PR #6** = root→`feature/video-studio-rebuild-p5` (E1), **PR #7** = `-p1`→root (E2+E3+E4); ambos OPEN (2026-10-04). El merge de la cadena rebuild y de estas PRs, y la PR final root→`develop`, deciden los humanos.

## Open items
- Frontend toggles (music path + volume, subtitles on/off, vertical) and voice dropdown: follow-up feature, not started.
- Default subtitle style (font/size/position) is ours; the Atlas note gets a line if it lands.

## Next step
PRs #6 (E1) y #7 (E2+E3+E4) abiertas — esperan revisión/decisión humana (merges, luego root→`develop`). Opcional con autorización: e2e real en spark (Wan T2V single-frame + Piper).
