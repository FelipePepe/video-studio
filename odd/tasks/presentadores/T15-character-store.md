# T15 — character store (SQLite + files), generation routes and the `presenterAssets` seam

## Goal
Presenters are picked by character id (T13). This task builds the server-side store those ids resolve against: a user describes a character, the server generates one image (felt puppet on a flat green background) through ComfyUI, analyses it (key colour + bounding box, T15a), stores image and metadata, and lets the user approve it. Only approved characters can be used by a job. The store also implements the `presenterAssets` seam that T14 added to the orchestrator. Generation goes through an injectable seam so tests need neither ComfyUI nor ffmpeg.

## Files
- `backend/src/db/schema.ts` (add the `characters` table to `SCHEMA_SQL`)
- `backend/src/db/connection.ts` (new migration, version 4)
- `backend/src/characters/characterRepository.ts` (new)
- `backend/src/characters/characterGenerator.ts` (new: `CharacterGenerator` type, prompt builder, ComfyUI-backed default)
- `backend/src/characters/presenterAssets.ts` (new: `createPresenterAssets`)
- `backend/src/routes/characters.ts` (new)
- `backend/src/app.ts` (wiring only, see "Wiring in app.ts")
- `backend/test/characterRepository.test.ts` (new)
- `backend/test/characters.routes.test.ts` (new)
- `backend/test/presenterAssets.test.ts` (new)

Read first: `db/connection.ts` (`MIGRATIONS`, `runMigrations`, `openDatabase`) and `db/schema.ts` (`SCHEMA_SQL`), `jobs/jobRepository.ts` and `pipeline/draftRepository.ts` (row <-> object mapping, injectable `Clock`/`IdFactory`, `node:sqlite` prepared statements), `routes/music.ts` and `routes/jobs.ts` (router factory style, `res.sendFile(rel, { root })` at the end of the artifact route), `config/auth.ts` (`makeTokenAuth`, applied globally in `buildApp` to every POST/PUT/PATCH/DELETE, so the new routes are protected with no extra code), `media/characterAnalysis.ts` (`analyzeCharacter`, `runFfmpegCapture`, `CharacterAnalysis`), `comfy/workflows.ts` (`buildT2VWorkflow`, `LIGHTX2V_STILL_CFG`), `clients/comfy.ts` (`ComfyClient.submit/waitForCompletion/download`, `extractOutputFile`, `isComfyUnavailable`), and `pipeline/orchestrator.ts` `executeStills` (the exact 1-frame still recipe to copy), plus `test/jobs.routes.test.ts` and `test/approve.routes.test.ts` for supertest + in-memory DB style. If `~/.copilot/rules/db.md` / `api.md` exist, follow them.

## Prerequisites
- T13 committed (`PresenterOptions`, character ids validated with `/^[A-Za-z0-9_-]{1,64}$/`).
- T14 committed. What T14 already put in the code, so this task does not redo or conflict with it:
  - `orchestrator.ts` exports `interface PresenterAssets { imagePath: string; keyColor: string; crop: { x; y; w; h }; mouthY?: number }` and `OrchestratorDeps.presenterAssets?: (characterId: string) => Promise<PresenterAssets>`.
  - `app.ts` already has `presenterAssets?: (characterId: string) => Promise<PresenterAssets>` on `AppOptions` (the composition-root options interface; it is named `AppOptions`, not `BuildAppOptions`) and passes `presenterAssets: opts.presenterAssets` to `createExecute({ ... })`.
  - Production default is still `undefined` after T14. This task only changes where that value comes from.

## Design decisions (already made, do not revisit)
1. **Table** `characters`, created in `SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS`, fresh databases) AND by migration `{ version: 4, name: 'characters-table' }` in `MIGRATIONS` (existing databases; the body is the same `CREATE TABLE IF NOT EXISTS`, same pattern as version 3 `jobs-warnings`). Columns:
```sql
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  seed INTEGER NOT NULL,
  image_path TEXT NOT NULL,          -- absolute path of the PNG
  key_color TEXT NOT NULL,           -- '0xRRGGBB'
  crop TEXT NOT NULL,                -- JSON {x,y,w,h}
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  mouth_y REAL,                      -- nullable: fraction of the cropped height; sprite builder default when NULL
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','approved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
   Plus `CREATE INDEX IF NOT EXISTS idx_characters_status_created ON characters(status, created_at)`.
2. **Id and path safety.** Ids are server-generated (`randomUUID()`, 36 chars of hex and `-`, which satisfies `/^[A-Za-z0-9_-]{1,64}$/`; the factory is injectable for tests). Export `const CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/` and `isValidCharacterId(id)` from `characterRepository.ts` (T13's regex literal stays where it is; do not edit `routes/pipeline.ts`). Every route validates `:id` with it BEFORE any DB or filesystem access and answers `400 { error: 'invalid character id' }`. Files live at `<charactersDir>/<id>/character.png`; `charactersDir` is absolute (`resolve(opts.charactersDir ?? 'data/characters')`, like `workDir`). The repository builds the path itself from the validated id and, before writing or deleting, asserts `resolve(path).startsWith(charactersDir + sep)`; never use a client-provided string in a path. The client never supplies `id`, `imagePath` or `keyColor`.
3. **Generator seam.** In `characterGenerator.ts`:
```ts
export interface CharacterGenInput { prompt: string; negativePrompt: string; seed: number; signal?: AbortSignal }
/** Returns the bytes of ONE PNG. */
export type CharacterGenerator = (input: CharacterGenInput) => Promise<Buffer>;
export function buildCharacterPrompt(description: string): { prompt: string; negativePrompt: string };
export function comfyCharacterGenerator(resolveComfy: () => ComfyClient): CharacterGenerator;
```
   - `buildCharacterPrompt`: `prompt = "${description.trim()}. Original hand-made felt puppet character, front view, upper body, facing the camera, mouth closed, soft felt texture, studio lighting, centred, on a flat solid uniform bright green background, nothing else in the frame, no text"`. `negativePrompt` extends the workflow default list with `green clothing, green fur, green skin, shadows on the background, gradient background, multiple characters, text, watermark`. The fixed text must not contain the word "Muppet" nor any Disney/trademarked character name.
   - `comfyCharacterGenerator` copies the still recipe of `executeStills` exactly: `comfy.submit(buildT2VWorkflow({ prompt, negativePrompt, seed, numFrames: 1, pingpong: false, saveImage: true, useLightx2v: true, width: 1024, height: 1024, filenamePrefix: 'character' }))`, `comfy.waitForCompletion(id, { signal })`, `extractOutputFile(outputs)` (throw `Error('ComfyUI returned no image output')` when null), `Buffer` from `comfy.download(file)`. Resolve the client at call time (`resolveComfy()`), like every other route, so a changed host needs no restart.
4. **Analysis at generation time.** After the generator returns: write the PNG to `<charactersDir>/<id>/character.png`, then `analyzeCharacter(png, imagePath, { runFfmpegCapture: deps.runFfmpegCapture })` (`runFfmpegCapture` is the real one from `media/characterAnalysis.ts` by default, injectable). The row is inserted only after the analysis succeeds. If the generator or the analysis throws, remove the `<id>/` directory (`rmSync(dir, { recursive: true, force: true })`, only after the path-prefix assertion) and insert nothing. `mouth_y` stays NULL (nothing computes it yet); `POST /:id/approve` accepts an optional `mouthY` (see routes).
5. **Status flow.** New characters are `generated`. `approve` sets `approved` (idempotent). `presenterAssets` accepts only `approved` characters. Regenerating means creating a new character (new id) and deleting the old one; there is no in-place regenerate.
6. **`createPresenterAssets(repo)`** in `presenterAssets.ts`:
```ts
export function createPresenterAssets(repo: Pick<CharacterRepository, 'get'>): (characterId: string) => Promise<PresenterAssets>;
```
   (`PresenterAssets` is imported from `../pipeline/orchestrator`, defined by T14.) It must: reject (throw `Error`) when the id fails `isValidCharacterId`, when the character does not exist (`character "<id>" not found`), when its status is not `approved` (`character "<id>" is not approved`), or when `existsSync(imagePath)` is false (`character "<id>" image is missing`); otherwise return `{ imagePath, keyColor, crop, ...(mouthY !== null ? { mouthY } : {}) }` (omit `mouthY` when NULL, T14 spreads it conditionally). Do not catch: T14 turns any rejection into the "presenters failed, rendering without them" warning. Accept an optional second argument `exists: (p: string) => boolean = existsSync` for tests.
7. **Concurrency.** Generation is synchronous in the request (a lightx2v 1-frame still takes tens of seconds). Allow ONE generation at a time per process; a second concurrent `POST /api/characters` answers `429 { error: 'a character is already being generated' }`. Use a module-local boolean released in `finally`.
8. **Repository** (`characterRepository.ts`), plain functions or a small class over `DatabaseSync`, in the style of `draftRepository.ts`, with injectable `Clock` and `IdFactory`:
```ts
export type CharacterStatus = 'generated' | 'approved';
export interface Character {
  id: string; name: string; description: string; seed: number;
  imagePath: string; keyColor: string;
  crop: { x: number; y: number; w: number; h: number };
  width: number; height: number; mouthY: number | null;
  status: CharacterStatus; createdAt: string; updatedAt: string;
}
export interface CharacterRepository {
  create(input: { name: string; description: string; seed: number; png: Buffer; analysis: CharacterAnalysis }): Character; // writes the file, inserts the row
  get(id: string): Character | undefined;
  list(): Character[];                         // newest first
  approve(id: string, opts?: { mouthY?: number }): Character | undefined;
  remove(id: string): boolean;                 // deletes row and <id>/ directory
}
export function createCharacterRepository(db: DatabaseSync, charactersDir: string, deps?: { clock?: Clock; newId?: IdFactory }): CharacterRepository;
```
   `create` writes the PNG first, then inserts; if the insert throws, it removes the directory and rethrows.

## Routes — `routes/characters.ts`, mounted at `/api/characters`
```ts
export interface CharactersDeps {
  repo: CharacterRepository;
  generate: CharacterGenerator;
  runFfmpegCapture: AnalyzeDeps['runFfmpegCapture'];
}
export function charactersRouter(deps: CharactersDeps): Router;
```
JSON shape returned for a character (never expose `imagePath` or any filesystem path): `{ id, name, description, status, keyColor, crop, width, height, mouthY, imageUrl: '/api/characters/<id>/image', createdAt, updatedAt }`.
- `POST /` body `{ name: string, description: string, seed?: integer }`. `name`: non-empty trimmed string, max 80 chars; `description`: non-empty trimmed string, max 500 chars; `seed`: optional integer 0..4294967295, default `randomBytes(4).readUInt32BE(0)`. Anything else -> `400 { error: <message> }` (messages: `name is required`, `description is required`, `seed must be an integer`). Success -> `201` with the character. Errors: generator `isComfyUnavailable(e)` -> `503 { error: 'ComfyUI unavailable' }`; other generator error -> `502 { error: 'character generation failed: <message>' }`; analysis error (message `could not locate the character in the image` or a PNG error) -> `422 { error: 'could not analyse the generated image: <message>' }`; busy -> `429`.
- `GET /` -> `200 { characters: [...] }` newest first. Optional query `?status=approved|generated` (any other value -> 400).
- `GET /:id` -> `200` character, `404 { error: 'character not found' }`.
- `GET /:id/image` -> `res.type('image/png')` + `res.sendFile(basename, { root: dirname })` as `routes/jobs.ts` does (callback answers 404 if the file is gone); 404 if the character does not exist.
- `POST /:id/approve` optional body `{ mouthY?: number }` (a number in `[0.05, 0.95]`, else `400 { error: 'mouthY must be a number between 0.05 and 0.95' }`) -> `200` character with `status: 'approved'`; 404 if missing.
- `DELETE /:id` -> `204`; 404 if missing.
All write routes are covered by the global `makeTokenAuth` (401 without the token when `API_TOKEN`/`apiKey` is set); no extra guard in the router.

## Wiring in app.ts (minimal; T14 already added the `presenterAssets` option and its pass-through to `createExecute`)
1. `AppOptions` gains three optional fields (do not touch the existing `presenterAssets` field T14 added):
```ts
/** Directory for generated character images. Defaults to `data/characters` (resolved absolute). */
charactersDir?: string;
/** Character image generator (ComfyUI 1-frame still by default). Injectable for tests. */
characterGenerator?: CharacterGenerator;
/** ffmpeg runner that returns stderr (cropdetect), used to analyse a generated character. */
runFfmpegCapture?: AnalyzeDeps['runFfmpegCapture'];
```
2. In `buildApp`, BEFORE the `JobRunner` is created: `const characterRepo = createCharacterRepository(db, resolvePath(opts.charactersDir ?? 'data/characters'));`.
3. In the existing `createExecute({ ... })` call change ONLY the T14 line `presenterAssets: opts.presenterAssets,` to `presenterAssets: opts.presenterAssets ?? createPresenterAssets(characterRepo),`. An injected `opts.presenterAssets` still wins (T14 tests keep working).
4. Mount: `app.use('/api/characters', charactersRouter({ repo: characterRepo, generate: opts.characterGenerator ?? comfyCharacterGenerator(resolvers.resolveComfy), runFfmpegCapture: opts.runFfmpegCapture ?? runFfmpegCapture }));` next to the other routers, before `errorHandler`.
No other change to `app.ts`. If `opts.jobs?.execute` is injected, the characters routes still work (they do not depend on it).

## Tests (write first, must fail first)
Use `openDatabase(':memory:')`, a temp dir for `charactersDir` (`mkdtempSync`, removed in `afterEach`), a fake `CharacterGenerator` that returns a small valid RGB PNG built in the test with `zlib.deflateSync` (green 64x64 background, a 20x30 non-green rectangle; copy the PNG-building helper from `test/characterAnalysis.test.ts`, do not edit that file), and a fake `runFfmpegCapture` that resolves with `"... crop=20:30:22:17"` text. No ComfyUI, no real ffmpeg.

`test/characterRepository.test.ts`
1. `SCHEMA_SQL` and migration 4 both yield the table: a fresh `openDatabase(':memory:')` has `characters`; a database stamped `user_version = 3` without the table gets it when `runMigrations` runs.
2. `create` writes `<dir>/<id>/character.png` (absolute path, inside `charactersDir`), stores key colour, crop JSON, status `generated`, injected clock timestamps and id.
3. `get` / `list` (newest first) round-trip `crop` and `mouthY: null`.
4. `approve` sets status `approved`, stores `mouthY` when given, is idempotent, returns `undefined` for an unknown id.
5. `remove` deletes the row and the directory, returns `false` for an unknown id.
6. Path safety: `get`/`approve`/`remove` with `'../x'`, `'a/b'`, `''` and a 65-char id never touch the filesystem (spy: create a sentinel file next to `charactersDir` and check it survives `remove('../sentinel')`); `isValidCharacterId` accepts `ana`, `a_B-9`, 64 chars, rejects 65 chars, `.`, `..`, `a b`, `a/b`.
7. If the insert fails (force a duplicate id via a fixed `newId`), the directory of the second attempt is cleaned up and the first character is intact.

`test/presenterAssets.test.ts`
1. Approved character -> `{ imagePath, keyColor, crop }` with the stored values and NO `mouthY` key when NULL; with `mouthY` set -> it is included.
2. `generated` (not approved) -> rejects `is not approved`; unknown id -> rejects `not found`; invalid id (`'../x'`) -> rejects without calling `repo.get`; missing file (inject `exists: () => false`) -> rejects `image is missing`.

`test/characters.routes.test.ts` (supertest + `buildApp({ db, charactersDir, characterGenerator, runFfmpegCapture, apiKey? })`)
1. `POST /api/characters` valid body -> 201, JSON has `status: 'generated'`, `keyColor` matching `/^0x[0-9a-f]{6}$/`, `crop` from the fake capture (padded as `analyzeCharacter` does), `imageUrl`, and NO `imagePath`; the generator received a prompt containing the description plus "green background" and a negative prompt containing `green clothing`; the prompt never contains "muppet" (case-insensitive).
2. Validation -> 400 for: missing/empty/over-long `name`, missing/over-long `description`, non-integer or out-of-range `seed`, with the exact messages above; the generator is not called.
3. Generator throws `ComfyUnavailableError` -> 503; generic error -> 502; neither leaves a directory or row behind. Analysis fails (fake capture without `crop=`) -> 422, directory and row removed.
4. Second `POST` while the first is pending (generator awaits a promise the test resolves later) -> 429; after the first completes a new `POST` works (flag released also after a failure).
5. `GET /` lists newest first; `?status=approved` filters; `?status=nope` -> 400. `GET /:id` 200/404; invalid id (`/api/characters/..%2Fx`, `/api/characters/a.b`) -> 400 or 404 without touching the filesystem (assert the exact status the router returns for an id failing the regex: 400).
6. `GET /:id/image` -> 200, `Content-Type` `image/png`, body bytes equal to the generator PNG; 404 for unknown id and after the file is deleted.
7. `POST /:id/approve` -> 200 `status: 'approved'`; with `{ mouthY: 0.62 }` stored and returned; `{ mouthY: 2 }` -> 400; unknown -> 404.
8. `DELETE /:id` -> 204 then `GET` 404 and the file is gone; unknown -> 404.
9. Auth: with `apiKey: 'secret'`, `POST`/`DELETE`/`approve` without token -> 401; `GET /` and `GET /:id/image` without token -> 200.
10. Integration with the seam: create + approve a character through the routes, then `(await createPresenterAssets(repo)(id))` through the same app's repo is not reachable from outside, so instead assert wiring by calling `buildApp({ ..., jobs: { execute } })`-independent route behaviour only; the end-to-end check "job with `presenters` uses the store" is covered by T14's injected-seam test and by the real render task. (Do NOT export internals from `app.ts` just for this test.)

Existing tests: grep for `user_version` (probably `test/connection.test.ts`). If an existing assertion hard-codes `3` as the latest version, update ONLY that number to `4`; touch nothing else in existing tests.

## Acceptance
- `cd backend && node --test --import tsx test/characterRepository.test.ts test/presenterAssets.test.ts test/characters.routes.test.ts` green.
- `test/connection.test.ts`, `test/app.test.ts`, `test/orchestrator.test.ts`, `test/orchestrator.presenters.test.ts`, `test/approve.routes.test.ts`, `test/characterAnalysis.test.ts` still green; `pnpm typecheck` green from the repo root.
- No client-supplied string reaches a filesystem path; no response exposes a filesystem path.
- `buildApp()` with no options still starts (default `data/characters` is created lazily by the repository on the first `create`, never at startup).

## Do NOT touch
`media/ffmpeg.ts`, `media/audioEnvelope.ts`, `media/characterAnalysis.ts`, `pipeline/orchestrator.ts` (T14 owns `PresenterAssets` and the stage), `pipeline/types.ts`, `routes/pipeline.ts` (T13 owns `parseApproveOptions`), `comfy/workflows.ts`, `clients/comfy.ts`, `config/auth.ts`, the frontend (T16 owns the UI), existing tests (except the single version number noted above), `PipelineAgent`. No `lipsync`, no UI, no in-place regenerate, no mouth-position detection (`mouth_y` stays NULL unless set at approve time).

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
