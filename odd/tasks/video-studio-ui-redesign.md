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
- [ ] doc de feature + mirror Engram (esta)
- [ ] deal 3 direcciones dev-tool + elección razonada
- [ ] hoja completa con paleta/type
- [ ] inventario de 124 clases + tells de markup
- [ ] reescritura de styles.css (tokens)
- [ ] ajustes de markup (máx 3 ficheros)
- [ ] lint.mjs sin FAIL
- [ ] pnpm test frontend (120) verde
- [ ] typecheck + build verde
- [ ] commit unitario (Conventional)
- [ ] inspect.mjs / screenshots del dist + 1 rondita de corrección
- [ ] reporte final + bitácora finish + Engram + PR

## Evidencia de verificación

(récorder salidas reales de cada runner antes de marcar)

## Progress

2026-10-18: doc creada, en fase 3 (deal de paleta).
