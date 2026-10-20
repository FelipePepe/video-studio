{
  "meta": {
    "plan": "video-studio — Tareas pendientes del plan de mejoras",
    "base": "develop (2bad699, 287 tests, 0 fail)",
    "principio": "Orden: autocontenido/testable primero → requiere infra ComfyUI → requiere espiga.",
    "regla": "Un cambio por PR. TDD (RED→GREEN→REFACTOR). Suite 287+ antes de commit."
  },
  "blocked": [
    {
      "id": "E1",
      "title": "§6 Documental con títeres (espiga)",
      "why_blocked": "espiga no es reachable (curl timeout). El doc dice 'empieza con una espiga sobre babybeast' pero babybeast es el host de producción (Wan2.2). No hay un segundo host disponible. Hay que subir espiga ANTES de poder prototipar el rig de títeres.",
      "exit_criterion": "espiga.casa o espiga:8188 responde a /object_info con un nodo de títeres/rig funcional"
    }
  ],
  "plan": [
    {
      "phase": "A",
      "title": "§4 Ritmo — transiciones y montaje (polish, self-contained)",
      "priority": 1,
      "why": "100% ffmpeg + orchestrator, testable, sin dependencias externas. El doc llama esto la mejora estética #1.",
      "steps": [
        {
          "step": 1,
          "description": "Solapar silencios: al concatenar, cada clip de audio ya tiene silencio al inicio y al final (TTS de Piper lo incluye). Problema: el concat actual hace 'clip1 + clip2' de forma adyacente, duplicando los silencios de transición. Solución: solapar 0.3s (300ms) entre clips usando 'acrossfade' de ffmpeg en el mux final en vez de 'concat'. Esto da un fade-in/fade-out suave sin cortar.",
          "tool": "read",
          "args": {"path": "backend/src/media/ffmpeg.ts"},
          "reason": "Entender muxAudioArgs y concatArgs para saber cómo implementar el overlap.",
          "substeps": [
            {"step": 1, "description": "Leer muxAudioArgs + musicMixArgs para entender los inputs y outputs.", "tool": "read", "args": {"path": "backend/src/media/ffmpeg.ts", "offset": 94, "limit": 40}, "reason": "Ver la firma y args del mux actual."},
            {"step": 2, "description": "Añadir function newAudioCrossfade(audioFiles, overlaps, out) con filter_complex: '[a0][a1]acrossfade=d=0.3[a01];[a01][a2]acrossfade=d=0.3[a012];...' + [v0]concat[av]", "tool": "edit", "args": {"path": "backend/src/media/ffmpeg.ts"}, "reason": "Implementar la función de crossfade."},
            {"step": 3, "description": "Añadir test de args: audioCrossfadeArgs con 3 clips + overlaps → filtro correcto.", "tool": "edit", "args": {"path": "backend/test/ffmpeg.test.ts"}, "reason": "Testear la nueva función."}
          ]
        },
        {
          "step": 2,
          "description": "Video crossfade (xfade) entre transiciones: ya existe xfadeArgs pero no se usa en el pipeline. El doc dice 'usar minterpolate para transiciones de la escala', pero la transición actual (WanVideo I2V) ya da un video fluido de transición, así que el xfade no es necesario. En CAMBIO: hacer el xfade de 0.5s entre el clip final de la transición y la escena siguiente (en el concat final) para suavizar el corte.",
          "tool": "edit",
          "args": {"path": "backend/src/pipeline/orchestrator.ts"},
          "reason": "Cablear el xfade de video en el concat final (opcional, depende del resultado de paso 1).",
          "substeps": [
            {"step": 1, "description": "Decidir si usar xfade o solo audio crossfade (los dos no se combinan bien — elegir uno).", "tool": "read", "args": {"path": "doc/video-studio-propuesta-de-mejoras.md"}, "reason": "Revisar qué dice el doc."}
          ]
        },
        {
          "step": 3,
          "description": "Ken Burns variado por escena: hoy usa el mismo zoom/pan para todas. Añadir variación determinística: en la escala, ya se tiene visualPrompt; mapear un hash del prompt a {zoomIn|zoomOut|panLeft|panRight|panCenter}, y variar zoomTo entre 1.05-1.30 según hash.",
          "tool": "edit",
          "args": {"path": "backend/src/pipeline/orchestrator.ts"},
          "reason": "Ejecutar: ejecutarStills → kenBurnsArgs ya recibe zoomTo; ahora se puede variar.",
          "substeps": [
            {"step": 1, "description": "Añadir function kenBurnsFor(prompt, i) en orchestrator: hash(prompt) → {zoomTo, direction}.", "tool": "edit", "args": {"path": "backend/src/pipeline/orchestrator.ts"}, "reason": "Implementar la variación."},
            {"step": 2, "description": "Añadir kenBurnsArgs pan/zoom variants en ffmpeg.ts (panLeft, panRight, zoomIn, zoomOut).", "tool": "edit", "args": {"path": "backend/src/media/ffmpeg.ts"}, "reason": "Soportar direcciones distintas de Ken Burns."},
            {"step": 3, "description": "Test: kenBurnsArgs con zoomIn/panLeft produce filtros distintos.", "tool": "edit", "args": {"path": "backend/test/ffmpeg.test.ts"}, "reason": "Testear."}
          ]
        },
        {
          "step": 4,
          "description": "Test + suite + PR",
          "tool": "bash",
          "args": {"command": "cd backend && pnpm typecheck && pnpm test"},
          "reason": "Verificar todo verde antes de commit.",
          "substeps": [
            {"step": 1, "description": "Suite verde → git commit → push → PR.", "tool": "bash", "args": {"command": "git add -A && git add ... && git commit && gh pr create"}, "reason": "Entregar."}
          ]
        }
      ]
    },
    {
      "phase": "B",
      "title": "§1 LoRa (lightx2v 4-step) + style global",
      "priority": 2,
      "why": "babybeast tiene wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors → 1/5 de la generación. style global da consistencia entre escenas.",
      "steps": [
        {
          "step": 1,
          "description": "LoRa lightx2v 4-step en I2V: añadir nodo LoraLoader a buildI2VWorkflow (workflows.ts), cargar wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors, reducir numFrames de 33 a 8-16 (con 4-step denoise no hace falta 33).",
          "tool": "read",
          "args": {"path": "backend/src/comfy/workflows.ts"},
          "reason": "Entender la estructura actual del I2V workflow.",
          "substeps": [
            {"step": 1, "description": "Spike en babybeast: confirmar el nombre del nodo LoraLoader que usa WanVideoSampler (LoraLoaderModelOnly?).", "tool": "bash", "args": {"command": "curl -s 192.168.1.60:8188/object_info | grep -i loraloader | head -10"}, "reason": "Verificar nodo disponible."},
            {"step": 2, "description": "Añadir nodo LoraLoader a buildI2VWorkflow, conectar al sampler.", "tool": "edit", "args": {"path": "backend/src/comfy/workflows.ts"}, "reason": "Implementar."},
            {"step": 3, "description": "Probar render I2V con LoRa (spike en orchestrator o e2e babybeast).", "tool": "bash", "args": {"command": "node tmp_spike_i2v_lora.mts"}, "reason": "Verificar."},
            {"step": 4, "description": "Test de workflows.ts: buildI2VWorkflow tiene nodo LoraLoader con el nombre correcto.", "tool": "edit", "args": {"path": "backend/test/workflows.test.ts"}, "reason": "Asegurar."}
          ]
        },
        {
          "step": 2,
          "description": "style global: añadir field 'style' en draft/escaleta (opcional). Si existe, prepend a visualPrompt de TODAS las escenas + transitions. Default: 'consistent style throughout'.",
          "tool": "edit",
          "args": {"path": "backend/src/pipeline/types.ts"},
          "reason": "Añadir el campo.",
          "substeps": [
            {"step": 1, "description": "Añadir style?: string al tipo Draft + Escaleta.", "tool": "edit", "args": {"path": "backend/src/pipeline/types.ts"}, "reason": "Tipo."},
            {"step": 2, "description": "En executeStills + executeTransitions, si draft.style, usarlo como prefijo de visualPrompt.", "tool": "edit", "args": {"path": "backend/src/pipeline/orchestrator.ts"}, "reason": "Aplicar."},
            {"step": 3, "description": "En prompts.ts (escaleta), añadir 'style' al prompt Ollama (opcional).", "tool": "edit", "args": {"path": "backend/src/pipeline/prompts.ts"}, "reason": "Generar si no existe."},
            {"step": 4, "description": "Test: execute con style → visualPrompt tiene el prefijo.", "tool": "edit", "args": {"path": "backend/test/orchestrator.test.ts"}, "reason": "Asegurar."}
          ]
        },
        {
          "step": 3,
          "description": "Suite + PR (LoRa + style juntos o separados)",
          "tool": "bash",
          "args": {"command": "cd backend && pnpm typecheck && pnpm test && git add -A && ..."},
          "reason": "Verificar + entregar."
        }
      ]
    },
    {
      "phase": "C",
      "title": "§7 Sonido — ACE-Step 1.5 (música generada)",
      "priority": 3,
      "why": "babybeast tiene ace_step_v1_3.5b.safetensors. Reemplaza el music-path de archivo por música generada por ComfyUI. El doc lo ve como 'el más de producto'.",
      "prerequisite": "Spike: confirmar workflow ACE-Step (nodo TextToMusic o AceStep) en babybeast.",
      "steps": [
        {
          "step": 1,
          "description": "Spike ACE-Step: descubrir workflow (nodos) en babybeast. Cargar model, generar 10s de música, descargar → MP3.",
          "tool": "bash",
          "args": {"command": "curl -s 192.168.1.60:8188/object_info | grep -iE 'acestep|ace_step' | head -20"},
          "reason": "Ver nodos ACE-Step disponibles."
        },
        {
          "step": 2,
          "description": "buildMusicWorkflow(prompt, seed, durationSec) en workflows.ts: CheckpointLoader(ace_step_v1_3.5b) → TextEncoder → AceStepTextToMusic → SaveAudio. Retorna {prompt, positive_prompt, seed, duration, model}.",
          "tool": "edit",
          "args": {"path": "backend/src/comfy/workflows.ts"},
          "reason": "Implementar workflow de música."
        },
        {
          "step": 3,
          "description": "Stage nuevo en orquestador: executeMusic — por escena, genera música (ACE-Step) + guarda MP3 en audioDir. Luego en assemble, la usa como fondo (ya existe musicMixArgs).",
          "tool": "edit",
          "args": {"path": "backend/src/pipeline/orchestrator.ts"},
          "reason": "Cablear el stage."
        },
        {
          "step": 4,
          "description": "Cabecera con lyrics (Ollama): en executeMusic (o antes), generar 2-4 líneas de lyrics por Ollama, pasarlas como 'lyrics' al workflow ACE-Step (si lo soporta) o simplemente como contexto.",
          "tool": "edit",
          "args": {"path": "backend/src/pipeline/orchestrator.ts"},
          "reason": "Añadir cabecera."
        },
        {
          "step": 5,
          "description": "Suite + PR",
          "tool": "bash",
          "args": {"command": "cd backend && pnpm typecheck && pnpm test && ..."}
        }
      ]
    },
    {
      "phase": "D",
      "title": "§7 Guión + Publicación",
      "priority": 4,
      "why": "Self-contained (Ollama, sin infra nueva). Aporta valor de producto (hook/CTA + título+tags).",
      "steps": [
        {
          "step": 1,
          "description": "Guion (hook/CTA): en prompts.ts, añadir campos 'hook' (primera frase gancho, ≤10 palabras) + 'cta' (última frase call-to-action) al objeto escaleta. En executeStills, el narrador ya lo usa (lo añade como narration).",
          "tool": "edit",
          "args": {"path": "backend/src/pipeline/prompts.ts"},
          "reason": "Generar campos."
        },
        {
          "step": 2,
          "description": "Publicación: en routes/pipeline.ts o en orquestador, al final del pipeline, llamar a Ollama con (título artículo + escaleta) → {title, description, tags[10]}. Guardar en la job (columna 'publish' o en outputPath).",
          "tool": "edit",
          "args": {"path": "backend/src/routes/pipeline.ts"},
          "reason": "Generar metadata."
        },
        {
          "step": 3,
          "description": "Suite + PR",
          "tool": "bash",
          "args": {"command": "..."}
        }
      ]
    },
    {
      "phase": "E",
      "title": "§8 Resto (T2V→SaveImage, WebSocket, streaming, Ken Burns paralelo)",
      "priority": 5,
      "why": "Polish. Requiere inspeccionar workflow ComfyUI (T2I) o cambios de firma (download/stream).",
      "steps": [
        {"step": 1, "description": "T2I: descubrir workflow T2I (Wan T2I / FLUX?) en babybeast. buildT2IWorkflow(prompt) reemplaza al '1-frame T2V'.", "tool": "bash", "args": {"command": "curl -s 192.168.1.60:8188/object_info | grep -iE 'WanT2I|Wan.*T2I|TextToImage' | head"}, "reason": "Verificar."},
        {"step": 2, "description": "WebSocket: reemplazar polling (waitForCompletion con fetch /history) por WebSocket /ws/status/{id}. En ComfyClient, añadir conexión WS + listener. Test con ws mock.", "tool": "edit", "args": {"path": "backend/src/clients/comfy.ts"}, "reason": "Implementar."},
        {"step": 3, "description": "Download streaming: download(file, outPath) en vez de download(file)→Buffer. Usar Node:fs createWriteStream + res.body (Readable).", "tool": "edit", "args": {"path": "backend/src/clients/comfy.ts"}, "reason": "Implementar."},
        {"step": 4, "description": "Ken Burns paralelo: en executeAssemble, lanzar kenBurns de TODAS las escenas en paralelo (Promise.all) en vez de sequentially.", "tool": "edit", "args": {"path": "backend/src/pipeline/orchestrator.ts"}, "reason": "Paralelizar."}
      ]
    }
  ]
}
