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
- [x] Real render with presenters — job eff174be done 2026-11-01 02:36 local (5 h: stills 30 min, transitions 4.5 h, presenters 9 s, assemble 85 s), 0 warnings, 6 scenes. ffprobe: video.mp4 952 frames regular 1/24; overlay output lost 13 frames (one 0.583 s pts gap) because ffmpeg's default mp4 vfr mode drops frames whose timestamps collide after the overlay -> fixed with `-fps_mode cfr` (full re-run of the overlay: 952 frames, no gaps). final.mp4 audio 39.593 s = narration. Frame check: A bottom-left, B bottom-right, correct size. Re-rendered end to end after the fix via the UI (job 8ad1144b, 3 scenes, 2026-11-01 14:07): 0 warnings, video.mp4 347 frames = video_p.mp4 347 frames, no pts gaps, final.mp4 14.446 s = narration 14.446 s. Also exercised in the browser: approve body (job options.presenters with the character ids) and the Presentadores progress stage.
- [x] Browser check of the UI (headless Chromium 156 against Vite + the real backend, ES locale): dialogue draft shows the "Presentadores en pantalla" switch; turning it on opens PresenterSetup with the create form and the two approved characters (images served, no page errors). Second pass: choosing Presenter A = Ana and B = Leo in the pickers works and shows the placement hint, no page errors. NOT exercised in the browser: the approve body (covered by unit tests, not clicked to avoid a 5 h render) and the progress stage. The 502 seen once was Ollama returning invalid JSON for a short text, not the UI.
- [ ] Visual polish found in the frame check: green fringe around both characters (chromakey spill; try despill or a larger blend) and the open-mouth gap shows as a hard dark bar on Leo — pending, not blocking
- [x] PR to `develop` — https://github.com/FelipePepe/video-studio/pull/77 (open, not merged)
- [ ] T17 noise fix (user-approved 2026-11-01, in PR #77, NO push until the user sees the diff): (a) `buildI2VWorkflow` non-lightx2v path uses shift 16 (validated at 1280x720); lightx2v keeps shift 5; T2V path unchanged (shift 16 not validated for stills); (b) UI switch "Modo rápido"/"Fast mode" in ReviewPanel render options, OFF by default, sends `useLightx2v: true` in the approve body (backend already accepts it). Route: delegated writer (2+ files). TDD on; runners: backend `node --test --import tsx`, frontend `vitest`.
- [ ] 3B lip-sync spike — BLOCKED (needs user authorization for destination, operation, credential)

## Evidence and decisions
- Render timing reference (Wan2.2 on the GB10): 1-frame still ~4.5 min, 33-frame transition ~53 min each. A 6-scene video takes ~5 h; use 2-3 scenes for checks.
- Real ffmpeg found what fakes could not (3f92d5b): `alphaextract` needs `format=yuva420p` before it and `cropdetect` needs `skip=0` for a 1-frame input. Sampled key colours on real characters: 0x3ad637, 0xa3dd09.
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

## Open findings (2026-11-01)
- Noise / over-saturated look in Wan transitions: our I2V defaults are cfg 6.0, 50 steps, switch 42/50 (84 %); official Wan2.2 `wan_i2v_A14B.py` is cfg 3.5, 40 steps, shift 5, boundary 0.9 (switch 36/40). Hypothesis "cfg 6 over-cooks" was TESTED AND REFUTED (2026-11-01 14:52): the same transition at the official cfg 3.5 / 40 steps / switch 36 took 2517 s and is just as noisy as cfg 6 (sometimes worse), so cfg is not the cause. A/B test queued on ComfyUI with the same stills/prompt/seed as eff174be trans_00 (cfg 3.5 / 40 steps) plus a lightx2v (4 steps, cfg 1) variant. Defaults NOT changed yet.
- Measured 2026-11-01 (same two stills, 33 frames, 1280x720): current defaults (50 steps, cfg 6) = ~53 min and a noisy, over-saturated result (swirl texture, colours shifted); lightx2v (4 steps, cfg 1) = 237 s of ComfyUI execution and a clean, sharp, natural-colour result in 5 frames inspected. Caveats: one scene pair, the seeds differ (1000 vs the baseline's draft seed), only 5 frames compared. Reference run cfg 3.5 / 40 steps = 2517 s, noisy like the current defaults. Conclusion: the non-distilled path itself is broken or misconfigured (suspects not yet tested, ~40 min per run: scheduler/shift in `buildTail`, fp8 scaled loading, T5 variant, negative prompt, high/low switch wiring), while the lightx2v path is clean. Cheap isolation tests at 640x352, 33 frames, same stills/seed, no lightx2v (~4-11 min each, 2026-11-01): cfg 6/50 steps = noisy (577 s); cfg 1/40 steps = near-pure noise (230 s); base_precision bf16 instead of fp16_fast = identical noise (691 s); scheduler euler instead of unipc = same noise (627 s). RULED OUT: cfg, base precision, scheduler. FOUND (same setup, 640x352): empty negative prompt = broken flat image (the negative is required); SHIFT is the main lever: shift 5 (current) noisy, shift 8 (cfg 6/50 steps, 558 s) recognisable octopus, shift 12 (564 s) cleanest of all; but shift 8 with the official cfg 3.5/40 steps/switch 36 (449 s) is noisy again, so shift + cfg/steps interact. Even shift 12 is still over-saturated and clearly less clean than lightx2v. shift 16 (cfg 6/50 steps, 560 s) is the cleanest so far: natural colours, coherent textures, close to the lightx2v look. shift 24 FAILS in ComfyUI ("index 43 is out of bounds" from the scheduler), so there is an upper limit. CONFIRMED at 1280x720 (2026-11-01 17:19): shift 16, cfg 6, 50 steps, switch 42, same stills/seed = 3196 s, clean and sharp, comparable to the lightx2v result (237 s). Root cause of the noise: `DEFAULTS.shift = 5.0` in `backend/src/comfy/workflows.ts` (official T2V uses 12, I2V 5 in the native pipeline, but this WanVideoWrapper path needs ~16). Proposed fix, NOT applied (needs user OK): shift 16 for the non-distilled I2V/T2V path; check T2V stills too (they used shift 5 as well) and keep lightx2v as the fast option. Not yet tried: shift 14/20, more steps. NOT YET TESTED: fp8_scaled quantization loading, T5 variant, negative prompt, the high->low sampler hand-off (start_step/end_step wiring), single-expert run. Scripts used live in the session scratchpad only (`lowres.mts`/`variant.mts` mutate the workflow JSON from `buildI2VWorkflow`). Candidate change: make lightx2v the default for transitions (and expose it in the UI), pending the user's go-ahead.
- LTX-Video installed on the Spark (user-authorised, SSH): `checkpoints/ltxv-13b-0.9.8-distilled-fp8.safetensors` (15.7 GB) and `text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors` (5.2 GB). No LTX workflow in the backend yet; untested.

## Idea parked (not started, not authorised)
- Timeline view like a professional video editor (layers: scenes/transitions, narration + music, presenters A/B mouth states, subtitles, on a time/frame ruler). Assessment 2026-11-01: (1) read-only timeline from job artifacts + `sceneFrameBounds` is viable and low risk; (2) limited edit with re-assemble only (~85 s, reuse cached clips) is medium effort; (3) full NLE with arbitrary layers and real-time preview is not recommended (needs a project model and an in-browser compositor). Decide after the user has judged the real render.
