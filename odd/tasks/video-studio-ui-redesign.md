# Feature: video-studio — rediseño de UI con house rules de design-taste-frontend

- **Rama**: `feature/ui-house-redesign` (desde `develop` @ dffc80e)
- **Autor**: agente (pi) — aprobada por usuario el 2026-10-18
- **Alcance**: solo `frontend/` + esta doc. **No toca** hooks, API, pipeline, i18n strings (salvo tells), tests.
- **Excepción de alcance declarada**: la skill dice "not for app screens"; el usuario eligió aplicar sus house rules como guía de rediseño de la UI de app, sin el flujo de página pública (draw/idea/imagery se usan solo como referencia de tokens).

## Objetivo

Sacar la UI de la estética por defecto (índigo `#4f46e5`, hairlines, glass en modal) hacia un sistema de tokens decidido:
un ground, un ink, un accent; superficies por paso de tono; botones planos; tipografía display+texto;
focus visible; dark/light automáticos con las mismas proporciones.

## Decisiones

| # | Decisión | Evidencia |
|---|----------|-----------|
| 1 | Todo el estilo es `src/styles.css` global (352 L, tokens `:root`) | `rg className` → 124 classes, ningún CSS module/Tailwind |
| 2 | Accent índigo prohibido por house rules ("no violet or indigo") | `styles.css:8 --accent: #4f46e5` |
| 3 | La paleta se toma de un `draw.mjs --sector dev-tool`, no inventada | SKILL.md paso 3: "Don't invent, deal" |
| 4 | Modal con `backdrop-filter`/scrim: los modales "float" → scrim + sombra legítimos (rule: shadows only on what floats) | `SettingsModal.tsx` |
| 5 | Sin subagents en este runtime: trabajo acotado en-thread, lectura completa antes de escribir (regla de 4+ archivos) | route declaration |

## Hoja de dirección

- Sector: `dev-tool` · seed 28653417
- **Elección: `product-performs`** — razon: la app demuestra el pipeline funcionando en directo (escaleta → render); es la composición nativa de una tool. Las otras dos (sentence-as-layout, borrowed-category) son editoriales y pelearían con la naturaleza del software.
- **Paleta** (adaptada a themes; proporciones de la hoja): dark ≈ base `#0d060b`, surface `#1b0e17`, ink `#ffffff`, muted `#9a8f97`, accent `#ff488b` con texto `#0d060b` sobre accent; light = mismas proporciones (base lavada tinte plum, ink plum-black, accent igual, ink-on-accent idéntico).
- **Type**: Work Sans 300/400/500 (hoja) + font-display 300 tracking -0.035em; body 16-19px leading 1.55; interfaz "fragment" (data-ui) 13-15px legítimos.
- **Radio**: 4px único (hoja, frame corner); botones planos, 4px, ink-on-pink en ambos themes.
- **Motion app**: micro-feedback hover/press/focus; etapas con transición de tono; `prefers-reduced-motion` respeta; nada que oculte contenido.
- **Adaptación app (documentada)**: la hoja es de página pública; la app conserva su grid shell, sidebar, modales. Se toma: tokens, tipografía, prohibiciones (índigo, glass, hairlines, gradientes, sombras a reposo), y el espíritu "fragment functioning" = los paneles ya lo son.

## Inventario de la app

| Fichero | L | Nota |
|---------|---|------|
| i18n.tsx | 311 | copy ES/EN; guía con pasos reales (ol legítimo) |
| ReviewPanel.tsx | 276 | editor de escenas, input step=0.05 (número funcional, no tell) |
| usePipeline.ts (hook) | 252 | **fuera de alcance** |
| api/client.ts | 206 | **fuera de alcance** |
| SettingsModal.tsx | 201 | modal glass-candidate |
| JobsPage.tsx | 186 | lista de trabajos |
| SegmentEditor.tsx | 150 | |
| PipelineForm.tsx | 111 | form principal |
| ProgressStages.tsx | 77 | `aria-current="step"` — semántica correcta |
| Sidebar.tsx | 64 | nav |
| PipelinePage.tsx | 58 | |
| VideoPanel.tsx | 42 | |
| App.tsx | 55 | shell grid |
| EscaletaCards.tsx | 24 | |
| GuideCard.tsx | 15 | pasos reales |

## Checklist

- [x] feature branch desde develop
- [x] doc de feature + mirror Engram (esta)
- [x] deal 3 direcciones dev-tool + elección razonada (product-performs, seed 28653417)
- [x] hoja completa con paleta/type
- [x] inventario de 90 clases + tells de markup
- [x] reescritura de styles.css (tokens) + index.html (Work Sans)
- [x] ajustes de markup: SegmentEditor (✕→×), i18n (⚙ sacado de strings)
- [x] lint.mjs 0 FAIL / 0 WARN
- [x] pnpm test frontend: 148/148 (16 ficheros) verde
- [x] typecheck + build verde
- [x] commit unitario 13ae9fb + 03b8365 (Conventional)
- [x] inspect.mjs: medidas OK (Work Sans 100%, display 48px -0.035em); 3 FAIL app-scope defendidos
- [ ] PR sobre develop (decisión del usuario)

## Evidencia de verificación

- `lint.mjs frontend/src` → `RESULT: 0 FAIL, 0 WARN` (después de 2 rondas: ✕→×, ⚙→sin emoji, shadows de diálogo justificados, borders de form-controls justificados, 100vh→100svh, voice-badge relleno)
- `pnpm --filter @video-studio/frontend test` → `Test Files 16 passed (16) · Tests 148 passed (148)`
- `pnpm --filter @video-studio/frontend typecheck` → `tsc --noEmit` sin errores
- `pnpm --filter @video-studio/frontend build` → `✓ built in 16.67s` (CSS 12.26 kB, JS 181.92 kB)
- `inspect.mjs http://127.0.0.1:8899/` → hero "Pipeline" 1 línea · 48px (3.3vw) · Work Sans 300 · tracking -0.035em · leading 1; typefaces Work Sans 100%; color page #faf6f8 · button #ff488b.
- **Defensas (app scope, no ocultación):** 3 FAIL del inspector (`few-pictures`, `focal-point`, `still-page`) + 1 WARN (`no-footage`) se deben a (a) ser UI de app, no página pública (la skill declara "Not for dashboards or app screens") y (b) estado vacío: sin job completado no hay imágen/vídeo honesto del producto; las reglas de la skill prohíben precisamente una imágen falsa. La capa de motion real de la app es feedback (hover/press/focus/transiciones), no coreografía de scroll.
- Screenshots: `.taste-skill/inspect/{desktop,tablet,mobile}-{fold,page-01}.jpg` (leídos críticamente, 2 rondas).
- Commits: `13ae9fb` rediseño base · `03b8365` rondas de inspector. Lefthook (branch-protection + gitleaks) verde en ambos.

## Progress

2026-10-18: completo hasta la defensa del inspector; pendiente apertura de PR (decisión del usuario).
