# Plan — video-studio: presentadores tipo muppet (fases 1 y 2)

## Context

`video-studio` (`/mnt/nas/sources/ai-tools/video-studio`) convierte una URL o un texto en un vídeo narrado: Ollama genera la *escaleta*, una persona la revisa, y después Piper (TTS), ComfyUI (Wan 2.2) y ffmpeg renderizan el vídeo. Hay dos motivos para este plan:

1. **La imagen se degrada en el vídeo.** La revisión del código, todavía sin vídeos reales porque `data/jobs` está vacío, apunta a cuatro causas:
   - Las codificaciones intermedias usan CRF 23 implícito, y esos clips llegan tal cual al resultado final por `concat -c copy`.
   - La salida 9:16 recorta una franja de 405×720 y la amplía ×1,78.
   - `zoompan` redondea posiciones con un sobremuestreo de solo ×2, lo que hace temblar la imagen.
   - Con la LoRA lightx2v se usa `cfg 6`, cuando esa LoRA está destilada para `cfg 1`.
2. **Nueva idea.** Dos presentadores originales, de estilo muppet, explican la noticia o el documental en diálogo, sobre un vídeo de fondo explicativo.

Decisiones ya tomadas:
- **Ampliar y refactorizar el proyecto, sin empezar de cero.**
- Hardware: DGX Spark (128 GB unificados, ARM64) y un presupuesto de hasta 1 día por vídeo de unos 3 minutos.
- Este plan cubre la **fase 1** (calidad del fondo) y la **fase 2** (guion con presentadores). Las fases 3 (prueba de lip-sync en la Spark) y 4 (composición) tendrán su propio plan, porque dependen de lo que midamos en la fase 3.

Ejecución:
- **qwen3.8 implementa a través de `pi`** en modo no interactivo.
- **Claude orquesta:** escribe un brief por tarea, lanza `pi`, revisa el diff, ejecuta los tests y hace los commits.

## Protocolo de orquestación (pi + qwen3.8)

- **Modelo:** `ollama/qwen3.8:256k` (Ollama en `192.168.1.60:11434`). Hoy **no está declarado** en `~/.pi/agent/models.json`, que solo tiene `qwen3.5:122b-a10b` y `qwen3.6:35b`. Hay que añadirlo en la máquina desde la que se ejecute pi.
- **Brief por tarea:** `odd/tasks/presentadores/T<n>-<slug>.md`. Debe ser autocontenido e incluir objetivo, ficheros, test que tiene que fallar primero (TDD estricto), criterios de aceptación y una lista de lo que no debe tocar.
- **Lanzamiento:** desde la raíz del repo, `pi -p --model ollama/qwen3.8:256k --no-session @odd/tasks/presentadores/T<n>-<slug>.md "Ejecuta la tarea del brief. Sigue TDD: primero el test que falla."`
- **Verificación de Claude** después de cada tarea:
  - Revisar `git diff` con el alcance del brief: rechazar ficheros fuera de él.
  - Ejecutar `pnpm typecheck` y `pnpm test`.
  - Si algo falla: un reintento con el feedback concreto. Si vuelve a fallar, lo corrige Claude o se escala al usuario.
- **Commits:** uno por tarea, conventional commits, sin líneas de atribución IA. Al final, PR a `develop` con `gh pr create --base develop`. Nunca merge directo.

## Plan

```json
{"plan": [
  {"step": 1, "description": "Preparación del repo y de pi", "tool": "Bash", "args": {"query": "git config core.fileMode false; git checkout -b feature/presentadores-fase1-2; añadir qwen3.8:256k a ~/.pi/agent/models.json"}, "reason": "Hay 159 ficheros marcados como modificados solo por permisos (644→755, por el NAS). Sin esto, los diffs de pi serían ilegibles. GitFlow exige trabajar en feature/*.",
   "substeps": [
     {"step": 1, "description": "Copiar este plan a odd/tasks/presentadores/PLAN.md, en el NAS", "tool": "Bash", "args": {"query": "cp ~/.claude/plans/logical-meandering-crayon.md /mnt/nas/sources/ai-tools/video-studio/odd/tasks/presentadores/PLAN.md"}, "reason": "Para que la sesión en la máquina correcta pueda leerlo, porque ~/.claude/plans es local a la clockworkpi."},
     {"step": 2, "description": "Comprobar que git status queda limpio y que `pi --list-models qwen3.8` lista el modelo", "tool": "Bash", "args": {"query": "git status --short | wc -l; pi --list-models qwen3.8"}, "reason": "Verificar la preparación antes de delegar nada."}
   ]},
  {"step": 2, "description": "FASE 1 — Calidad del vídeo de fondo (4 tareas delegadas a pi)", "tool": "Bash", "args": {"query": "pi -p --model ollama/qwen3.8:256k --no-session @odd/tasks/presentadores/T1..T4"}, "reason": "Arreglar lo que ya falla antes de montar los presentadores encima.",
   "substeps": [
     {"step": 1, "description": "T1 cfg con lightx2v — backend/src/comfy/workflows.ts: añadir `cfg?` a CommonOptions; samplerInputs usa `o.cfg ?? DEFAULTS.cfg`; withLightx2v pone `cfg: o.cfg ?? 1`. Test en backend/test/workflows.test.ts: con useLightx2v, los dos WanVideoSampler tienen cfg 1, y sin él, cfg 6.", "tool": "Bash", "args": {"query": "pi -p ... @T1-cfg-lightx2v.md"}, "reason": "Las LoRAs de lightx2v están destiladas para cfg 1. Con cfg 6 se queman el color y el contraste."},
     {"step": 2, "description": "T2 CRF explícito — backend/src/media/ffmpeg.ts: constante exportada `VIDEO_CRF = 18`, aplicada en kenBurnsArgs, xfadeArgs y normalizeClipArgs (hoy van sin -crf, es decir, 23); burnSubtitles y vertical* también usan la constante. Tests en backend/test/ffmpeg.test.ts y vertical.test.ts.", "tool": "Bash", "args": {"query": "pi -p ... @T2-crf.md"}, "reason": "Los clips de Ken Burns y las transiciones pasan con concat -c copy al final.mp4, así que su CRF es la calidad final."},
     {"step": 3, "description": "T3 Ken Burns sin temblor — kenBurnsArgs: sobremuestreo ×4 con `flags=lanczos` en lugar de ×2 sin flags. Test sobre el filtro generado. Medir el tiempo de codificación de un clip de 10 s, antes y después.", "tool": "Bash", "args": {"query": "pi -p ... @T3-kenburns.md"}, "reason": "zoompan trabaja con enteros, y un sobremuestreo mayor reduce el temblor visible."},
     {"step": 4, "description": "T4 9:16 sin ampliar — verticalCropArgs y verticalBurnSubtitlesArgs: sustituir crop+scale por un 'fit con fondo desenfocado' (split → [bg] scale 720:1280 de relleno + crop + boxblur; [fg] scale=720:-2; overlay centrado), manteniendo una sola pasada y el filtro de subtítulos al final. Tests en vertical.test.ts.", "tool": "Bash", "args": {"query": "pi -p ... @T4-vertical.md"}, "reason": "El recorte actual amplía 405 px de ancho ×1,78. El fit con fondo desenfocado no amplía la imagen principal."}
   ]},
  {"step": 3, "description": "FASE 2 — Guion en formato diálogo entre dos presentadores (4 tareas delegadas a pi)", "tool": "Bash", "args": {"query": "pi -p --model ollama/qwen3.8:256k --no-session @odd/tasks/presentadores/T5..T8"}, "reason": "Base de datos de la idea: los presentadores muppet necesitan saber quién dice cada frase. Las fases 3 y 4 cuelgan de esto.",
   "substeps": [
     {"step": 1, "description": "T5 Modelo — backend/src/pipeline/types.ts: `Scene.speaker?: 'A' | 'B'`. El tipo Scene del frontend (frontend/src/api) también. No hace falta migración: la escaleta se guarda como JSON en drafts.escaleta (draftRepository.ts).", "tool": "Bash", "args": {"query": "pi -p ... @T5-speaker-model.md"}, "reason": "Cambio mínimo y retrocompatible. Reutiliza voiceA/voiceB, que ya existen, como voces de los presentadores A y B."},
     {"step": 2, "description": "T6 Generación — backend/src/pipeline/draft.ts: DraftInput acepta `format?: 'narration' | 'dialogue'` (por defecto narration) y `hosts?: { a: string; b: string }`. En dialogue, systemPrompt pide una conversación entre los dos presentadores (cada escena es una intervención de uno, `speaker` A/B y visualPrompt como plano de fondo explicativo). validateEscaleta acepta y valida speaker, y deriva `voice` de speaker (A→voiceA, B→voiceB). Si falta speaker, se mantiene el comportamiento actual de mix. Tests en draft.test.ts, con Ollama falso.", "tool": "Bash", "args": {"query": "pi -p ... @T6-dialogue-draft.md"}, "reason": "El LLM decide quién habla. La voz se deriva de forma determinista y no se confía en el texto del LLM."},
     {"step": 3, "description": "T7 API — backend/src/routes/pipeline.ts: POST /draft valida y pasa format y hosts. PUT segments conserva speaker (validateEscaleta con keepVoices). Tests en pipeline.routes.test.ts.", "tool": "Bash", "args": {"query": "pi -p ... @T7-routes.md"}, "reason": "Exponer el formato sin romper los clientes actuales."},
     {"step": 4, "description": "T8 UI — PipelineForm.tsx: conmutador narración/diálogo y nombres de los presentadores. SegmentEditor.tsx: selector de speaker A/B por escena, que actualiza voice. i18n.tsx con claves ES/EN. Tests en frontend/test/PipelineForm.test.tsx y SegmentEditor.test.tsx.", "tool": "Bash", "args": {"query": "pi -p ... @T8-ui.md"}, "reason": "La revisión humana tiene que poder corregir quién dice cada frase."}
   ]},
  {"step": 4, "description": "Cierre: verificación completa, PR y memoria", "tool": "Bash", "args": {"query": "pnpm typecheck && pnpm test; gh pr create --base develop; mem_session_summary"}, "reason": "Entregar por GitFlow y dejar contexto para planificar las fases 3 y 4."}
]}
```

## Ficheros críticos

- `backend/src/media/ffmpeg.ts`: constructores puros de argumentos de ffmpeg. Los tests no necesitan ffmpeg real.
- `backend/src/comfy/workflows.ts`: `buildTail`, `samplerInputs`, `withLightx2v` y `DEFAULTS`.
- `backend/src/pipeline/draft.ts`: `systemPrompt`, `validateEscaleta` y `generateDraft`.
- `backend/src/pipeline/types.ts`, `backend/src/routes/pipeline.ts`.
- `frontend/src/components/PipelineForm.tsx`, `SegmentEditor.tsx`, `frontend/src/i18n.tsx`.
- Patrones a reutilizar:
  - Inyección por `buildApp(opts)` (`backend/src/app.ts`) con clientes falsos en los tests.
  - `test/helpers/fakeApi.ts` en el frontend.
  - Allowlist estricta de opciones (`parseApproveOptions`) como modelo para validar `format` y `hosts`.

## Fuera de alcance (planes posteriores)

- **Fase 3:** prueba de lip-sync en la Spark con un clip de 10 s (InfiniteTalk o Wan S2V) frente a la boca animada por volumen. Se mide tiempo y calidad.
- **Fase 4:** generación de personajes de referencia, render de presentadores, composición sobre el fondo y orquestador con fases configurables.
- **Stills con T2V de 1 frame:** solo se verifica con un render real (ver Verificación). Cambiar a un modelo de imagen sería otra tarea.
- **Conversión 16→24 fps de las transiciones** (duplica frames): se anota y se decide en la fase 4.

## Verificación

1. Después de cada tarea, `pnpm typecheck` y `pnpm test` deben quedar en verde. Si no, el test nuevo tiene que haber fallado antes del cambio (TDD).
2. **Fase 1, extremo a extremo:**
   - Un job real corto (3 escenas, `useLightx2v: true`, `vertical: true`) contra ComfyUI en la Spark.
   - `ffprobe` de `final.mp4` y `final_v.mp4` para comprobar resolución, fps y bitrate.
   - Comparación visual de un frame de Ken Burns y de una transición frente a un job anterior al cambio, generado con la misma escaleta y la misma seed.
3. **Fase 2:**
   - Draft en formato `dialogue` con una URL real: las escenas alternan speaker y las voces coinciden con voiceA y voiceB.
   - Editar el speaker en la UI y comprobar que se persiste.
   - Aprobar y comprobar que el audio alterna las dos voces de Piper.
