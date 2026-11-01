# T16 — UI: `PresenterSetup` (create/approve/delete characters, pick A and B) + `presenters` render option + `presenters` progress stage

## Goal
For a dialogue draft (scenes carry `speaker`), the human can, inside the review screen: create a felt-puppet character from a name and a description, see the generated image, approve or delete it, pick one approved character for presenter A and a different one for presenter B, and approve the draft with `options.presenters = { mode: 'volume', a, b }`. The progress list shows a "Presenters" stage when the job uses presenters. All copy is ES/EN. Backend contracts are fixed by T13 (approve option), T14 (stage `presenters`, degrade-with-warning) and T15 (`/api/characters`); this task is frontend only.

## Files
- `frontend/src/api/types.ts` (new `Character`, `CharacterStatus`, `PresenterOptions`; `ApproveBody.presenters?`)
- `frontend/src/api/client.ts` (6 character methods on `ApiClient` and `createApiClient`)
- `frontend/src/hooks/usePipeline.ts` (`presenters` stage; `PipelineApi` gains the character methods)
- `frontend/src/components/PresenterSetup.tsx` (new)
- `frontend/src/components/ReviewPanel.tsx` (state + render the setup + put `presenters` in the approve body)
- `frontend/src/components/ProgressStages.tsx` (label map entry)
- `frontend/src/i18n.tsx` (ES and EN keys)
- `frontend/src/styles.css` (new `presenters` block, existing tokens only)
- `frontend/test/helpers/fakeApi.ts` (character fakes on `PipelineApi`/`makeFakeApi`)
- `frontend/test/client.test.ts` (add tests)
- `frontend/test/PresenterSetup.test.tsx` (new)
- `frontend/test/ReviewPanel.presenters.test.tsx` (new; do not edit `ReviewPanel.options.test.tsx`)
- `frontend/test/usePipeline.test.tsx` (add tests; the existing "four pending stages" test must stay green unchanged)
- `frontend/test/ProgressStages.test.tsx` (add one test)

Read first: `src/api/client.ts` (`request`, `toApiError`, `ApiError.status`, `ApiClient` + `createApiClient`), `src/hooks/usePipeline.ts` (`STAGE_IDS`, `StageId`, `pendingStages`, `isStageId`, `applyEvent` stage-index logic, `approve`, `openJob`/`loadJob`, `PipelineApi`), `src/components/ReviewPanel.tsx` (options state, `approve()` body building, `useMusicLibrary`/`useVoices` hook style, `api` prop typing), `src/components/PipelineForm.tsx` (`segmented`, field markup), `src/components/ProgressStages.tsx`, `src/i18n.tsx` (key style, `dictionaries`, `MessageKey`), `src/styles.css` (`.render-options`, `.field`, `.btn`, `.form-error`, `.warnings`, `.stages__item`, the final focus-visible rule near line 475), and the tests `ReviewPanel.options.test.tsx`, `ProgressStages.test.tsx`, `usePipeline.test.tsx`, `client.test.ts`, `i18n.test.tsx` for conventions. Backend reference (read only): `odd/tasks/presentadores/T13`, `T14`, `T15` briefs.

## Contracts (from the backend briefs; do not revisit)
- Character JSON: `{ id, name, description, status: 'generated' | 'approved', keyColor, crop, width, height, mouthY: number | null, imageUrl, createdAt, updatedAt }`. `imageUrl` is `/api/characters/<id>/image` (GET, no token needed, `image/png`). No filesystem path is ever exposed.
- `POST /api/characters` `{ name, description, seed? }` -> 201 character, synchronous and slow (tens of seconds). Errors, all `{ error: string }`: 400 validation, 429 `a character is already being generated`, 503 `ComfyUI unavailable`, 502 `character generation failed: ...`, 422 `could not analyse the generated image: ...`.
- `GET /api/characters?status=approved|generated` -> `{ characters: Character[] }` newest first. `POST /api/characters/:id/approve` (optional body `{ mouthY }`) -> 200 character. `DELETE /api/characters/:id` -> 204 (empty body). `GET /:id` -> character / 404.
- Approve option (T13): `presenters: { mode: 'volume', a: string, b: string }`, `a !== b`. The backend rejects unknown keys.
- Job stage name (T14): `'presenters'`, emitted only when the job has presenters and the draft has speakers, between `transitions` and `assemble`. Degradations arrive as normal job warnings (`presenters skipped: ...`, `presenters failed, rendering without them: ...`), already shown by `ProgressStages` via `warnings`; nothing new is needed for them.

## Design decisions (already made, do not revisit)
1. **Types (`types.ts`).**
```ts
export type CharacterStatus = 'generated' | 'approved';
export interface Character {
  id: string; name: string; description: string; status: CharacterStatus;
  keyColor: string; crop: { x: number; y: number; w: number; h: number };
  width: number; height: number; mouthY: number | null;
  imageUrl: string; createdAt: string; updatedAt: string;
}
export interface PresenterOptions { mode: 'volume'; a: string; b: string }
// ApproveBody: presenters?: PresenterOptions;  (doc comment: character ids; only send when both chosen)
```
   Update the `ApproveBody` doc comment ("keep in sync with parseApproveOptions") only by adding the field; `Job.options` already uses `ApproveBody`, so a job's persisted `presenters` is readable for free.
2. **Client (`client.ts`)**, added to `ApiClient` and implemented with the existing `request`/`ApiError` (errors keep `status` so the UI can map 429/503/502/422):
```ts
listCharacters(params?: { status?: CharacterStatus }): Promise<Character[]>;   // unwraps { characters }
createCharacter(input: { name: string; description: string; seed?: number }): Promise<Character>;
approveCharacter(id: string, opts?: { mouthY?: number }): Promise<Character>;
deleteCharacter(id: string): Promise<void>;
```
   - `id` is always `encodeURIComponent`-ed in the path.
   - `request` today does `res.json()` on success: add a 204 branch (`if (res.status === 204) return undefined as T`) used by `deleteCharacter`; do not change behaviour for other statuses.
   - `listCharacters` and the others prefix `baseUrl` to the returned `imageUrl` (`${baseUrl}${c.imageUrl}`) so `<img src>` works when `baseUrl` is set; with the default `''` it is unchanged.
   - `getCharacter` is NOT added (nothing needs it).
3. **`PipelineApi`** in `usePipeline.ts` adds `'listCharacters' | 'createCharacter' | 'approveCharacter' | 'deleteCharacter'` to its `Pick`. `ReviewPanel`'s `api` prop type becomes `Pick<ApiClient, 'listMusic' | 'listVoices'> & Partial<Pick<ApiClient, 'listCharacters' | 'createCharacter' | 'approveCharacter' | 'deleteCharacter'>>` so the existing ReviewPanel tests (which pass only music/voices) compile and run unchanged; the presenters block is rendered only when all four methods exist. `fakeApi.ts` adds the four as `vi.fn` (defaults: `listCharacters` -> `[]`, others resolve a `Character`/`undefined`) to `makeFakeApi()` so `satisfies PipelineApi` still holds. After editing, `grep -rn "satisfies PipelineApi\|: PipelineApi" frontend/test` and fix only what the typechecker reports.
4. **Where the state lives.** Same place as every other render option: local state inside `ReviewPanel` (music, subtitles, vertical). Character selection (`presenterA`, `presenterB`: `string | ''`) is `ReviewPanel` state; the character list and the create/approve/delete operations live inside `PresenterSetup` (props below). `usePipeline.approve({ body })` already forwards the body unchanged; the only `usePipeline` changes are the stage handling in decision 8. No new global state.
5. **When it is shown / enabled.** `ReviewPanel` renders `<PresenterSetup>` inside the existing `render-options` fieldset, after the vertical row, only when `local.some((s) => s.speaker !== undefined)` (the draft is a dialogue, derived from the current local escaleta, so it follows edits) AND the four api methods exist. Narration drafts show nothing and never send `presenters`. The block is an opt-in: collapsed behind a switch `review.presenters` (same `switch` pattern as music), default OFF. Switching it ON loads the list (`listCharacters({ status: 'approved' })` for the pickers plus the generated-but-unapproved ones, see below) and shows the setup; switching it OFF hides it and drops the selection from the approve body (state is kept in memory while the draft is open).
6. **`PresenterSetup` component** (`src/components/PresenterSetup.tsx`, named export):
```ts
export interface PresenterSetupProps {
  api: Pick<ApiClient, 'listCharacters' | 'createCharacter' | 'approveCharacter' | 'deleteCharacter'>;
  /** Character ids currently chosen ('' = none). */
  a: string;
  b: string;
  onChange(next: { a: string; b: string }): void;
  /** Names of the dialogue hosts if known (optional hint shown as the A/B picker labels). Omit if unavailable. */
}
```
   Behaviour:
   - On mount it calls `api.listCharacters()` (all statuses) once; keeps `characters: Character[]`, `loading`, `listError`. A list failure shows `presenters.loadError` in a `role="alert"` with a retry button and leaves the pickers empty; it does not crash the review screen.
   - **Create form**: `name` input (required, trimmed, `maxLength` 80) and `description` textarea (required, trimmed, `maxLength` 500), both with visible `<label>`s and a live remaining-character hint not required. Submit button `presenters.create` is disabled while a request is pending or either field is blank. While pending: button label `presenters.generating`, the form region has `aria-busy="true"`, and a `role="status"` line says generation can take up to a minute; the form fields are disabled. On success: the new character is prepended to the list, fields are cleared, and focus moves to the new card's heading (`tabIndex={-1}`). A second concurrent create from the same page is impossible (button disabled); a 429 from another tab/page is still handled.
   - **Error mapping** (an `ApiError` from `createCharacter`; show one `role="alert"` `.form-error` in the form, cleared on the next submit/edit). By `status`: 429 -> `presenters.err.busy`; 503 -> `presenters.err.comfy`; 502 -> `presenters.err.generation` (append the server message after a colon only for 502/422/400, since those carry the useful detail; do NOT show raw server text for 429/503); 422 -> `presenters.err.analysis`; 400 -> the server message verbatim; any other error / network failure -> `presenters.err.generic`. The form keeps its text so the user can retry.
   - **Character cards** (a `<ul aria-label=…>` of `<li>` cards, newest first), each with: `<img src={imageUrl} alt={t('presenters.imageAlt', { name })} loading="lazy" width/height from the character>` (fixed `max-height` via CSS, `object-fit: contain`, on a neutral `--toned` background; the image has a green background by design, do not recolour it), the name as a heading (`h4`), the description (muted, clamped to 3 lines), a status badge text (`presenters.status.generated` / `presenters.status.approved`, text not only colour), and actions: **Approve** (`presenters.approve`, only for `generated`, calls `approveCharacter(id)`, replaces the card in place, pending-disabled), **Delete** (`presenters.delete`, danger style `btn--danger` if it exists, else `btn`; asks confirmation through the same in-app confirm pattern as `ConfirmDialog` in `ReviewPanel.tsx`: export that component from `ReviewPanel.tsx` is NOT allowed (file would be re-touched for a refactor); instead use a minimal two-step inline confirm on the card: first click shows `presenters.confirmDelete` + `presenters.deleteYes` / `presenters.deleteNo` buttons, never `window.confirm`). Deleting a character that is currently chosen as A or B calls `onChange` clearing that slot. A failed approve/delete shows a `role="alert"` message inside that card (`presenters.err.approve` / `presenters.err.delete`) and keeps the card.
   - **Pickers**: two `<select>`s, labels `presenters.pickA` / `presenters.pickB`, each with a first empty option `presenters.pickNone` and only `status === 'approved'` characters as options (option text = name). The option chosen in one select is `disabled` in the other (A != B enforced in the UI; if the parent state ever has a === b, the component treats the later one as unset when rendering). Changing a select calls `onChange({ a, b })` with `''` for "none". If no approved character exists the selects are disabled and a hint `presenters.noApproved` is shown. When both are chosen, show `presenters.ready`; when only one is chosen show `presenters.needBoth` (muted `role="note"`), because only a complete pair is sent.
   - The component never reads or shows `keyColor`/`crop`/`mouthY` (internal). `mouthY` is not editable in this task.
7. **Approve body (`ReviewPanel.approve`).** Add after the vertical line: if the presenters switch is ON and `presenterA !== '' && presenterB !== '' && presenterA !== presenterB` and the draft is a dialogue, set `body.presenters = { mode: 'volume', a: presenterA, b: presenterB }`. Otherwise do NOT include the key (both unset, only one chosen, switch off, narration). No error is raised for "only one chosen": it is a hint, not a blocker (consistent with "only send what differs from defaults"); the existing assertion `onApprove` called with `undefined` when everything is default must still hold. The selected ids must still exist: if a chosen id disappeared from the list (deleted) `PresenterSetup` already cleared it.
8. **Stage `presenters` in `usePipeline.ts`.** The stage exists only for jobs that use presenters, so the default list stays four stages (the existing "starts idle with four pending stages" test is unchanged). Implementation:
   - `STAGE_ORDER = ['tts', 'images', 'transitions', 'presenters', 'assemble'] as const` and `StageId = (typeof STAGE_ORDER)[number]`; keep exporting `STAGE_IDS` as the four base stages (`as const`, same values as today) if other code/tests import it, else derive it with a filter; `isStageId` accepts all five.
   - `withPresenters(stages)` inserts `{ id: 'presenters', status: 'pending' }` before `assemble` if absent. Call it (a) in `approve` when `options?.body?.presenters` is set, before `startRun`'s stage reset result is used (make sure the reset in `startRun` does not drop it: reset to `pendingStages(withPresenters)` for that run), (b) in `loadJob`/`openJob` when `job.options?.presenters` is set, (c) in `applyEvent` as a fallback when an event with `stage === 'presenters'` arrives and the list lacks it.
   - `applyEvent` must compute the active index from the CURRENT list (`prev.findIndex(s => s.id === stage)`), not from `STAGE_IDS.indexOf`, so inserting the stage never shifts statuses. A job without presenters never lists the stage, so its UI is byte-identical to today.
   - `reset()` returns to the four base stages.
9. **`ProgressStages.tsx`**: add `presenters: 'stage.presenters'` to `STAGE_LABEL` (the `Record<StageId, MessageKey>` forces it). `PipelinePage.tsx` needs no change (its `t(\`stage.${failedStage.id}\`)` resolves the new key). Labels: ES `Presentadores`, EN `Presenters`.
10. **i18n keys** (add to both `es` and `en`; the parity test enforces it). Style: dotted keys like the existing ones.

| key | ES | EN |
|---|---|---|
| `stage.presenters` | Presentadores | Presenters |
| `review.presenters` | Presentadores en pantalla | On-screen presenters |
| `presenters.title` | Presentadores | Presenters |
| `presenters.intro` | Crea personajes de fieltro, apruébalos y elige quién es A y quién es B. | Create felt-puppet characters, approve them and choose who is A and who is B. |
| `presenters.name` | Nombre | Name |
| `presenters.description` | Descripción | Description |
| `presenters.create` | Generar personaje | Generate character |
| `presenters.generating` | Generando… | Generating… |
| `presenters.generatingNote` | La generación puede tardar hasta un minuto. | Generation can take up to a minute. |
| `presenters.list` | Personajes | Characters |
| `presenters.imageAlt` | Personaje {name} | Character {name} |
| `presenters.status.generated` | Pendiente de aprobar | Awaiting approval |
| `presenters.status.approved` | Aprobado | Approved |
| `presenters.approve` | Aprobar | Approve |
| `presenters.delete` | Eliminar | Delete |
| `presenters.confirmDelete` | ¿Eliminar este personaje? | Delete this character? |
| `presenters.deleteYes` | Sí, eliminar | Yes, delete |
| `presenters.deleteNo` | Cancelar | Cancel |
| `presenters.pickA` | Presentador A | Presenter A |
| `presenters.pickB` | Presentador B | Presenter B |
| `presenters.pickNone` | Sin personaje | No character |
| `presenters.noApproved` | Aprueba al menos dos personajes para elegirlos. | Approve at least two characters to choose them. |
| `presenters.needBoth` | Elige A y B para mostrar presentadores; si no, el vídeo se genera sin ellos. | Choose both A and B to show presenters; otherwise the video renders without them. |
| `presenters.ready` | Los presentadores aparecerán abajo a la izquierda (A) y a la derecha (B). | Presenters will appear bottom-left (A) and bottom-right (B). |
| `presenters.loadError` | No se pudo cargar la lista de personajes. | Could not load the character list. |
| `presenters.retry` | Reintentar | Retry |
| `presenters.err.busy` | Ya se está generando otro personaje. Espera a que termine. | Another character is already being generated. Wait for it to finish. |
| `presenters.err.comfy` | ComfyUI no está disponible. Inténtalo de nuevo más tarde. | ComfyUI is unavailable. Try again later. |
| `presenters.err.generation` | La generación falló | Generation failed |
| `presenters.err.analysis` | No se pudo analizar la imagen generada. Prueba con otra descripción | Could not analyse the generated image. Try another description |
| `presenters.err.generic` | No se pudo crear el personaje. | Could not create the character. |
| `presenters.err.approve` | No se pudo aprobar el personaje. | Could not approve the character. |
| `presenters.err.delete` | No se pudo eliminar el personaje. | Could not delete the character. |

   `presenters.imageAlt` uses the existing `{name}` interpolation style (`t(key, { name })`); check how `t` params are written in `i18n.tsx` and follow it. The wording above can be adjusted for natural phrasing but both languages must keep the same key set.
11. **Styles (`styles.css`)**: one new section `/* Presenters ---- */` placed after the render-options block. Use ONLY existing tokens (`--toned`, `--toned-2`, `--surface`, `--ink`, `--muted`, `--accent`, `--danger`, `--radius`, `--step-ui`, `--step-small`); no new colours, no gradients, no borders as separators (tone steps), one radius. Classes: `.presenters` (grid, gap 12px), `.presenters__form` (grid, gap 10px; reuse `.field`), `.presenters__grid` (list reset, `display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px`), `.presenters__card` (`--surface` background, padding 12px, radius, grid gap 8px), `.presenters__img` (`width: 100%; max-height: 220px; object-fit: contain; background: var(--toned); border-radius: var(--radius)`), `.presenters__badge[data-status='approved']` (ink weight 500) vs generated (muted), `.presenters__desc` (muted, 3-line clamp), `.presenters__pickers` (two fields side by side, stack under 520px), `.presenters__confirm` (flex row). Add the new interactive selectors to the shared focus-visible rule near line 475 only if the existing generic `button`/`select`/`input`/`textarea` coverage does not already include them (check first). Layout must have no horizontal scroll at 360px width.
12. **Accessibility.** Every control has a visible label tied by `htmlFor`/`id` (`useId`). The create region is a `<fieldset>` with `<legend>`; the whole block lives in the existing `render-options` fieldset, so the switch uses `role="switch"` + label like its siblings. Errors: `role="alert"`; progress while generating: `role="status"` + `aria-busy`. Card list is a real `<ul>`; badges are text. After a create/approve/delete the focus never falls to `<body>` (move to the new card heading, or to the Generate button after a delete). Keyboard: all actions reachable with Tab/Enter/Space; inline delete confirm is focus-managed (Yes receives focus when it appears, Escape cancels and returns focus to Delete). Image `alt` is meaningful. No reliance on colour alone (the image background is green by design; badge and status are text).

## Tests (write first, must fail first)
Frontend runner: `cd frontend && pnpm vitest run test/<file>.test.tsx`. Conventions: `render` inside `<I18nProvider>` (default language ES; assert ES strings, plus one EN switch test via `setLang`/localStorage like the existing i18n tests), `userEvent.setup()`, `vi.fn` fakes from `test/helpers/fakeApi.ts`, no network.

`test/client.test.ts` (use the file's existing fake-fetch helper)
1. `listCharacters()` GETs `/api/characters`; with `{ status: 'approved' }` GETs `/api/characters?status=approved`; unwraps `{ characters }`.
2. `createCharacter({ name, description })` POSTs JSON to `/api/characters` and returns the character; with `seed` includes it; an error body `{ error: 'a character is already being generated' }` with 429 rejects an `ApiError` with `status === 429` and that message.
3. `approveCharacter('a b')` POSTs to `/api/characters/a%20b/approve` (no body without opts; body `{ mouthY }` with opts); `deleteCharacter('x')` sends `DELETE` and resolves `undefined` on a 204 with no body.
4. With `baseUrl: 'http://h'`, returned `imageUrl` is prefixed (`http://h/api/characters/<id>/image`).

`test/PresenterSetup.test.tsx` (fake api object with the four `vi.fn`, a `makeCharacter(over)` factory)
1. Loads and lists characters on mount; each card shows the image with alt `Personaje <name>`, the name, the description and its status text; newest first as returned.
2. Pickers contain only approved characters plus the "none" option; with no approved characters the selects are disabled and `noApproved` is shown.
3. Choosing A removes that character from B's enabled options (A != B); choosing in each select calls `onChange` with both ids; selecting "none" calls it with `''`. A parent state with a === b renders B as unset.
4. Create: the submit button is disabled with blank name/description (whitespace only counts as blank); filling both and clicking calls `createCharacter({ name, description })` with trimmed values; while pending the button is disabled, label is `Generando…`, the region has `aria-busy="true"` and the status note is present; on success the new card is first in the list, fields are cleared and the heading of the new card has focus.
5. Create errors, each as an `ApiError(status, msg)` rejection, shows the mapped alert and keeps the typed values: 429 -> busy copy; 503 -> comfy copy; 502 -> `La generación falló: <msg>`; 422 -> analysis copy with the server detail; 400 -> server message; a plain `Error` -> generic. The form is usable again (button re-enabled) after each.
6. Approve: a `generated` card has an Approve button, an `approved` card does not; clicking calls `approveCharacter(id)`, the card becomes approved and the character appears in both pickers; failure shows `No se pudo aprobar…` inside that card and keeps it generated.
7. Delete: first click shows the inline confirm (no api call yet, focus on "Sí, eliminar"); Escape or Cancelar aborts with focus back on Delete; confirming calls `deleteCharacter(id)` and removes the card; deleting a character chosen as A calls `onChange` clearing A; a failed delete shows the alert and keeps the card.
8. List failure shows `No se pudo cargar la lista de personajes.` with a Reintentar button that calls `listCharacters` again and then renders the list.
9. Accessibility: selects, inputs and textarea are reachable by `getByLabelText`; the card list is `getByRole('list', { name: 'Personajes' })`; errors are `getByRole('alert')`.
10. EN: with language `en` the labels (`Presenter A`, `Generate character`, `Approved`) appear.

`test/ReviewPanel.presenters.test.tsx` (api = `{ listMusic, listVoices, listCharacters, createCharacter, approveCharacter, deleteCharacter }` fakes; a `dialogueDraft` whose scenes have `speaker: 'A' | 'B'`; the shared `draft` has none)
1. Narration draft (no speakers): no presenters switch in the DOM, approve with defaults still calls `onApprove(undefined)`.
2. Dialogue draft: the switch `Presentadores en pantalla` exists, is OFF, and `listCharacters` is not called until it is turned ON; turning it ON shows the setup.
3. Both A and B chosen (two approved characters) + Approve -> `onApprove` called with `{ presenters: { mode: 'volume', a: 'c1', b: 'c2' } }` and nothing else when other options are default.
4. Only A chosen, or none -> `onApprove` called with `undefined` (key omitted); same after turning the switch OFF again with A and B previously chosen.
5. Combined with other options -> body contains `presenters` plus `vertical: true` / `subtitles: false`, no extra keys.
6. Removing the speakers by editing is not possible via the UI today, but if the `draft` prop switches to a narration draft (rerender with another `draft.id`) the presenters selection is dropped (state belongs to one draft) and the key is not sent.
7. If the api prop lacks the character methods (the old minimal api) the block is not rendered even for a dialogue draft.

`test/usePipeline.test.tsx` (add; do not edit existing cases)
1. `approve({ body: { presenters: { mode: 'volume', a: 'c1', b: 'c2' } } })` -> `stages.map(id)` is `['tts','images','transitions','presenters','assemble']`, all pending; then a `stage: 'presenters'` event marks `tts/images/transitions` done and `presenters` active, `assemble` pending.
2. `approve()` without presenters -> still the four stages; an `assemble` event marks the first three done as today (no regression).
3. A `presenters` stage event arriving on a job started without the option inserts the stage (fallback) without changing earlier statuses.
4. `openJob` of a job whose `options.presenters` is set (use `fakeJob({ options: { presenters: {...} } })`) lists five stages; `reset()` returns to four.
5. Warnings text such as `presenters failed, rendering without them: x` coming as a `message` on a `progress` event for `stage: 'presenters'` ends up in `warnings` (existing mechanism; assert it, no new code expected).

`test/ProgressStages.test.tsx`
1. Rendering five stages including `presenters` shows `Presentadores` between `Transiciones` and `Montaje`, in order, with the right `data-state`; with the four-stage list the output is unchanged.

`test/i18n.test.tsx` already enforces ES/EN key parity; do not edit it. It must stay green.

## Acceptance
- `cd frontend && pnpm vitest run test/client.test.ts test/PresenterSetup.test.tsx test/ReviewPanel.presenters.test.tsx test/usePipeline.test.tsx test/ProgressStages.test.tsx test/i18n.test.tsx` green, then `pnpm --filter @video-studio/frontend test` (the whole frontend suite, including the untouched `ReviewPanel.options.test.tsx`, `ReviewPanel.test.tsx`, `PipelinePage.test.tsx`, `App.test.tsx`) green.
- `pnpm typecheck` from the repo root green.
- No request carries `presenters` unless both A and B are chosen, different, the switch is ON and the draft has speakers. No UI text or request exposes `keyColor`, `crop` or filesystem paths.
- Not part of this task's acceptance: a real browser check of the UI (create a character against ComfyUI, pick A/B, render). That is a separate later task ("browser check of the setup UI" in `odd/tasks/presentadores-fase3-4.md`); here jsdom tests are enough.

## Do NOT touch
Everything under `backend/`; `frontend/src/components/PipelinePage.tsx`, `PipelineForm.tsx`, `SegmentEditor.tsx`, `JobsPage.tsx`, `SettingsModal.tsx`, `Sidebar.tsx`, `frontend/src/lib/escaleta.ts`, `frontend/src/App.tsx`; `ReviewPanel.options.test.tsx`, `ReviewPanel.test.tsx` and every other existing test not listed above; `odd/` files other than this brief; no `mouthY` editor, no regenerate-in-place, no lipsync mode, no `GET /api/characters/:id` client method, no new dependency, no router.

## Rules (apply to every task)
- Strict TDD: write/adjust the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Frontend tests: `cd frontend && pnpm vitest run test/<file>.test.tsx`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
