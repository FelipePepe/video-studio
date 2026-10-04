# video-studio-enhancements

**Status:** in progress · **Created:** 2026-10-04
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
- [ ] E1 BGM + ducking (route options → jobs.options → assemble) — route: inline (writer trigger fires — 5+ files — but no subagent mechanism in this pi runtime; recorded here).
- [ ] E2 Burned subtitles (SRT builder + timeline cue math + encode step).
- [ ] E3 Vertical 9:16 + cover thumb + `?variant=` routing.
- [ ] E4 `GET /api/voices` (Piper describe endpoint).

## Acceptance criteria
- `pnpm -r test` green; `pnpm -r typecheck` clean.
- E1: args-graph test (inputs, sidechaincompress, amix) + route validation (bad volume, missing file) + options persisted on the job row.
- E2: SRT builder + cue-math tests (transition offsets); final encode path exercised with a fake ffmpeg; optional local-ffmpeg integration.
- E3: crop/cover args tests + route variant behavior; default behavior (final.mp4 only) unchanged.
- E4: piper client `listVoices` against the fake Wyoming server + route shape test.

## Verification evidence
_(none yet)_

## Review assessments per task
(none yet — first native boundary for this feature is its root base)

## Slices (PRs)
Local: root `feature/video-studio-enhancements` ← `-p1` (E2) ← `-p2` (E3) ← `-p3` (E4).
Remote `FelipePepe/video-studio`: PRs `-p1`→root, `-p2`→`-p1`, `-p3`→`-p2`; final root → `develop` after rebuild chain merges (user-decided).

## Open items
- Frontend toggles (music path + volume, subtitles on/off, vertical) and voice dropdown: follow-up feature, not started.
- Default subtitle style (font/size/position) is ours; the Atlas note gets a line if it lands.

## Next step
E1 (root branch) — then p1 (E2), p2 (E3), p3 (E4), per-slice reviews, PRs.
