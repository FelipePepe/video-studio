# T14 — orchestrator `presenters` stage (mouth timelines -> sprites -> alpha clips -> overlay)

## Goal
When the approve options carry `presenters` (T13) and the draft is a dialogue (scenes have `speaker`), the job renders two felt-puppet presenters over the background video: A bottom-left, B bottom-right, mouths driven by each scene's TTS audio. Everything is wired from the pure pieces that already exist (T10..T12, T15a); this task only adds the orchestration, an injectable asset seam and tests with fake ffmpeg runners. A presenter failure must never fail the job.

## Files
- `backend/src/pipeline/orchestrator.ts`
- `backend/src/app.ts` (only: pass the new optional dep through to `createExecute`; see step 8)
- `backend/test/orchestrator.presenters.test.ts` (new)

Read first: `orchestrator.ts` (`createExecute`, `Shared`, `executeTTS`, `executeTransitions`, `executeAssemble`, `RANGES`, `begin/step/warn/run/guard`), `media/audioEnvelope.ts` (`mouthStates`, `presenterTimelines`, `SceneTrack`, `NORMALIZED_*`), `media/ffmpeg.ts` (`presenterSpriteArgs`, `presenterConcatList`, `presenterClipArgs`, `presenterOverlayArgs`), `pipeline/types.ts` (`ApproveOptions`, `PresenterOptions` from T13), and `test/orchestrator.test.ts` (the `harness()` with fake comfy/piper/ffmpeg that this test file copies).

## Prerequisite
T13 is committed: `ApproveOptions.presenters?: PresenterOptions` (`{ mode: 'volume'; a: string; b: string }`, character ids) exists in `types.ts`. T15 (character store) does NOT exist yet: this task defines the seam T15 will implement.

## Design decisions (already made, do not revisit)
1. **Where the overlay is applied: on `video.mp4` INSIDE `executeAssemble`, right after `concatArgs({ listFile: videoList, out: video })` and before any mux.** Justification from the code:
   - `video.mp4` is the silent concat of Ken Burns + normalised transition clips (1280x720, 24 fps, yuv420p); the narration is muxed later (`muxAudioArgs` / `musicMixArgs`). So the overlay runs on a video-only file and its `-map 0:a?` simply maps nothing.
   - Everything downstream (burned subtitles, `final_v.mp4` vertical variant built from `basePath`, `cover.jpg` taken from `basePath`) then includes the presenters with no extra change and no extra re-encode of the finished deliverable. Overlaying on `final.mp4` instead would need a second pass for `final_v.mp4` (and a different `videoHeight`), and would re-encode already-subtitled video.
   - Subtitles are burned over the presenters (presenters are in the bottom corners, subtitles bottom-centre); acceptable, and sizing is a later visual tweak, not this task.
   - Cost: one extra x264 pass over a video-only file. `videoHeight` is `720` (the Ken Burns / `normalizeClipArgs` height).
2. **The expensive/clip work is a separate stage, the overlay is a step of assemble.** New `Stage` value `'presenters'` runs after `transitions` and before `assemble` (it needs the `transitions` map to know the real gaps, and it only needs the WAVs from `tts`). It produces the two alpha clips. `executeAssemble` receives the optional clips and does the overlay. Literal "between tts and assemble" is therefore satisfied; it sits after `transitions` because the gap frames depend on which transitions succeeded.
3. **Active only when** `job.options?.presenters` is set AND `escaleta.some((sc) => sc.speaker !== undefined)` (dialogue-based). If `presenters` is set but no scene has a `speaker`, skip the stage and persist a warning (`s.warn('presenters', 'presenters skipped: the script has no speakers (narration format)')`). Otherwise no `presenters` events at all (the existing "stages are tts, images, transitions, assemble" test must stay green).
4. **Seam (injectable, like the other deps):**
```ts
export interface PresenterAssets {
  imagePath: string;                                      // absolute path of the character PNG
  keyColor: string;                                       // '0xRRGGBB' (CharacterAnalysis.keyColor)
  crop: { x: number; y: number; w: number; h: number };   // CharacterAnalysis.crop
  mouthY?: number;                                        // fraction of the cropped height; presenterSpriteArgs default when absent
}
// in OrchestratorDeps:
/** Resolves a character id to its approved image and analysis. Provided by the character store (T15). */
presenterAssets?: (characterId: string) => Promise<PresenterAssets>;
```
   If `presenters` is set but `deps.presenterAssets` is undefined: degrade (warning `presenters skipped: no character store configured`), do not throw. `app.ts` passes `opts.presenterAssets` through (new optional `BuildAppOptions.presenterAssets`) so tests and T15 can inject; production default stays undefined until T15.
5. **Failure semantics (mirror failed transitions).** The whole stage body runs in a try/catch:
   - `guard()` first in the catch: a cancelled job rethrows `AbortError` (never swallowed).
   - Any other error (asset lookup, sprite/clip ffmpeg failure, `mouthStates` throwing on a bad WAV, overlay failure): return `undefined` (no presenters), `s.warn('presenters', \`presenters failed, rendering without them: ${message(e)}\`)`, and the job continues exactly as if `presenters` were unset. Partial files are already removed by `run` (`removePartialFfmpegOutput`).
   - There is no ffmpeg-infrastructure abort here: ffmpeg is local and `run` already rethrows aborts; an ffmpeg spawn failure on a presenter step degrades like any other error (the subsequent assemble steps will surface a broken ffmpeg anyway). ComfyUI is not involved, so `ComfyUnavailableError` logic is untouched.
   - The overlay step inside assemble has the same degrade rule: try/catch around only that `run(presenterOverlayArgs(...))`; on a non-abort error `s.warn('assemble', 'presenter overlay failed, rendering without presenters: ...')` and keep `video` pointing at the plain `video.mp4`.
6. **Frame timeline without drift (the only subtle part).** `fps = 24`. Per scene `i` the real video duration is `durations[i]` seconds, followed by `transitionSec = frames / DEFAULTS.fps` seconds ONLY when `i < n - 1 && transitions[i]` (same predicate as `buildChapters` / `executeAssemble`). The gap (33/16 s = 49.5 frames) is not an integer, so never round per scene. Use cumulative boundaries:
```ts
// end boundary of the speech of scene i and of its gap, in frames from t = 0
let cumSec = 0; let prevEnd = 0;
for each scene i:
  const startF = prevEnd;                                  // = round(cumSec * fps) of the previous gap end
  cumSec += durations[i];
  const speechEndF = Math.round(cumSec * fps);
  cumSec += hasGap(i) ? transitionSec : 0;
  const gapEndF = Math.round(cumSec * fps);
  states   = mouthStates(wav_i, { fps, normalize: true }) // resized to exactly speechEndF - startF frames
  gapFrames = gapEndF - speechEndF
  prevEnd = gapEndF
```
   Export a small pure helper from `orchestrator.ts` so it is unit-testable without a harness:
```ts
export function sceneFrameBounds(durations: number[], gapSec: Array<number>, fps: number): Array<{ speechFrames: number; gapFrames: number }>;
```
   (`gapSec[i]` is `transitionSec` or `0`). `speechFrames[i] + gapFrames[i]` summed over scenes must equal `Math.round(totalSec * fps)` exactly. `mouthStates` returns `ceil(dur*fps)` states, which can differ by one from `speechFrames`: trim the array or pad it with `'closed'` to exactly `speechFrames` so the total length equals the sum of bounds. Then `presenterTimelines(scenes: SceneTrack[])` with `{ speaker: escaleta[i].speaker, states, gapFrames }`; both timelines end up with the same length `T = sum of bounds`.
7. **Per-presenter render (A and B each):**
   1. `assets = await deps.presenterAssets(presenters.a | presenters.b)` (two lookups, `Promise.all` is fine; no cache needed).
   2. Three sprites into `join(workDir, 'presenters')` (create the dir): `presenterSpriteArgs({ image: assets.imagePath, out: <dir>/<A|B>_<state>.png, state, keyColor: assets.keyColor, crop: assets.crop, ...(assets.mouthY !== undefined ? { mouthY: assets.mouthY } : {}) })` for `closed`, `mid`, `open`, each through `s.run`.
   3. `writeFileSync(<dir>/<A|B>.txt, presenterConcatList(timeline, sprites, 24))`.
   4. `s.run(presenterClipArgs({ listFile, out: <dir>/<A|B>.mov, fps: 24, frames: timeline.length }))`.
   Order: sprites A, clip A, sprites B, clip B; `guard()` before each. No content cache in this task (clips are cheap to rebuild; keying on voice+character is a later optimisation).
8. **Overlay in assemble:** `presenterOverlayArgs({ video, clipA, clipB, out: join(workDir, 'video_p.mp4'), videoHeight: 720 })`, then `video` for the mux steps becomes `video_p.mp4`. `executeAssemble` gets a 5th optional parameter `presenters?: { clipA: string; clipB: string }`. Its `AssembleResult` and the returned `outputPath` do not change.
9. **Progress:** `RANGES` becomes `tts [0,0.15]`, `images [0.15,0.55]`, `transitions [0.55,0.85]`, `presenters [0.85,0.90]`, `assemble [0.90,1]`. `begin('presenters')` once, then `step('presenters', done, 6)` after each of the 6 sprites... simpler and enough: `step('presenters', k, 2)` after presenter A and presenter B are done (sprites + clip). Progress stays monotonic (`advance` is max-based). The frontend `ProgressStages.tsx` / `i18n.tsx` do not know the `presenters` stage: leave them (T16 owns UI); the event `stage` is a free string so nothing breaks.

## Tests (write first, must fail first) — `backend/test/orchestrator.presenters.test.ts`
Copy the `harness()` pattern from `test/orchestrator.test.ts` (in-memory db, fake comfy/piper, recording fake `ffmpeg` that writes its last arg). Add `speaker` to the scenes (`A`, `B`, `A`) and `presenters` to the job (create the job with options `{ presenters: { mode: 'volume', a: 'ana', b: 'leo' } }`; check how `createJob` takes options and reuse the same helper style as the existing option tests). Give piper a non-silent WAV (a sine/square burst via `wavFromPcm`) so the mouth leaves `closed`. Inject `presenterAssets: async (id) => ({ imagePath: '/x/' + id + '.png', keyColor: '0x1e941b', crop: { x: 10, y: 20, w: 300, h: 400 } })`.
1. `sceneFrameBounds`: durations `[0.5, 0.75, 1]`, gaps `[2.0625, 2.0625, 0]`, fps 24 -> speech+gap frames sum to `Math.round(totalSec * 24)` exactly; no per-scene rounding drift for 20 scenes of 3.3 s with 2.0625 s gaps; every value is a non-negative integer.
2. Happy path: with `presenters` + speakers the stage events are `['tts','images','transitions','presenters','assemble']`; progress stays sorted and within [0,1]; ffmpeg calls contain 6 sprite invocations (three `-frames:v 1` PNGs per presenter, with `crop=300:400:10:20` and the sampled key `0x1e941b` in the filter), 2 clip invocations whose `-frames:v` equals the same value `T` for A and B (and `T` equals the sum of scene bounds), and exactly one overlay invocation (`[2:v]scale=-2:288` present, i.e. 720 * 0.4) whose `-i` input is `video.mp4` and whose output is `video_p.mp4`; the mux step (`muxAudioArgs`) uses `video_p.mp4` as its video input; final output path unchanged (`final.mp4`).
3. The concat lists written to `presenters/A.txt` and `B.txt` refer to the right sprites, and during a scene spoken by A the B list only contains the `closed` sprite (read the files and check that B's first run is `closed` for the whole of scene 0, and A's list contains `mid` or `open`).
4. Hard-cut transition (`failI2V: [0]`): the gap after scene 0 is 0 frames, so `T` shrinks by the transition frames; `T` still equals the sum of bounds for the actual transition map.
5. Not active: no `presenters` option -> no presenter ffmpeg calls and no `presenters` stage; `presenters` set but no scene has `speaker` -> no presenters stage, a persisted warning event (`warning: true`) containing "no speakers"; `presenters` set without `deps.presenterAssets` -> warning "no character store", job done.
6. Degradation: `presenterAssets` rejecting; a sprite ffmpeg call failing (fake ffmpeg throws when the args contain `chromakey`); the overlay call failing (throws when args contain `[2:v]`): each yields a `warning: true` event with "presenters failed" / "overlay failed", the job still returns `final.mp4`, and (for the overlay case) the mux input is the plain `video.mp4`.
7. Abort: aborting during the presenters stage (fake ffmpeg aborts the controller on the first sprite call) rejects with `AbortError` (not degraded, no warning).
8. Existing `test/orchestrator.test.ts` stays green unmodified (stage list is still the four stages without the option).

## Acceptance
- `cd backend && node --test --import tsx test/orchestrator.presenters.test.ts` green; `test/orchestrator.test.ts`, `test/presenter.test.ts`, `test/ffmpeg.test.ts`, `test/audioEnvelope.test.ts` still green; `pnpm typecheck` green from the repo root.
- Without `presenters`, the ffmpeg call sequence of a job is byte-identical to before.

## Do NOT touch
`media/ffmpeg.ts`, `media/audioEnvelope.ts`, `media/characterAnalysis.ts`, `routes/*` (T13 owns `parseApproveOptions`), `pipeline/types.ts` (T13 owns `PresenterOptions`), `contentCache.ts`, `chapters.ts`, the frontend, existing tests, `PipelineAgent`. No character store or routes (T15). No `lipsync` mode.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
