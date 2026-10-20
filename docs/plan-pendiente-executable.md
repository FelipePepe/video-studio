{
  "meta": {
    "plan": "video-studio — Plan de mejoras: ESTADO FINAL (consolidado en develop)",
    "base": "develop @ 96625ee (313 tests, 0 fail, typecheck clean)",
    "estado": "COMPLETADO salvo §6 (bloqueado: decisión de producto; requiere InfiniteTalk+Qwen-Image-Edit en babybeast). Todos los PRs mergeados en develop."
  },
  "completed": [
    {
      "id": "PR #15",
      "title": "docs: revisión completa de docs/README/plan (consistencia, errores, dead links, seguridad)",
      "status": "Merged"
    },
    {
      "id": "PR #16",
      "title": "feat(comfy): Wan2.2 dual-expert con switch-step (T2V + I2V)",
      "status": "Merged"
    },
    {
      "id": "PR #17",
      "title": "refactor(orchestrator): pipeline por etapas con progreso real por job",
      "status": "Merged"
    },
    {
      "id": "PR #18",
      "title": "feat(pipeline): caché de contenido (TTS/stills/transitions) keyable + skippable",
      "status": "Merged"
    },
    {
      "id": "PR #19",
      "title": "fix(pipeline): subtitles + portada en vertical (crop 9:16 antes de burn)",
      "status": "Merged"
    },
    {
      "id": "PR #20",
      "title": "refactor(article): extraction readable (linkedom) con fallback textContent",
      "status": "Merged"
    },
    {
      "id": "PR #21",
      "title": "ci: GitHub Actions (typecheck + test suite)",
      "status": "Merged"
    },
    {
      "id": "PR #22",
      "title": "docs: fix stale strings Kokoro→Piper en README",
      "status": "Merged"
    },
    {
      "id": "PR #23",
      "title": "fix(security): rate limit, CORS origin configurable, job id length cap",
      "status": "Merged"
    },
    {
      "id": "PR #24",
      "title": "feat(jobs): workDir retention policy (cleanup por edad)",
      "status": "Merged"
    },
    {
      "id": "PR #25",
      "title": "perf(ffmpeg): añadir -preset veryfast en reencodes de clips intermedios",
      "status": "Merged"
    },
    {
      "id": "PR #26",
      "title": "perf(pipeline): upload each still to ComfyUI once per run (memoize)",
      "status": "Merged"
    },
    {
      "id": "PR #27",
      "title": "refactor(pipeline): drop forced PcmFormat assertion in executeTTS",
      "status": "Merged"
    },
    {
      "id": "PR #28",
      "title": "§4 ritmo: Ken Burns variety per scene (zoom magnitude + direction determinística)",
      "status": "Merged"
    },
    {
      "id": "PR #29",
      "title": "§1 style: global visual style applied to all scenes for consistency",
      "status": "Merged"
    },
    {
      "id": "PR #30",
      "title": "§7 publicación: publish metadata (title/description/tags) + hook/CTA (draft + approve)",
      "status": "Merged"
    },
    {
      "id": "PR #31",
      "title": "§1 lightx2v: 4-step LoLA option (useLightx2v) ~10× faster, same quality",
      "status": "Merged (E2E validated: 61.77s, 86.4 MB, 5.2x faster)"
    },
    {
      "id": "PR #32",
      "title": "§7 música: ACE-Step 1.5 text-to-music workflow builder (buildAceStepMusicWorkflow)",
      "status": "Merged (E2E blocked: VAEDecodeAudio server-side, documented in PR)"
    },
    {
      "id": "PR #33",
      "title": "§8 streaming: downloadToFile stream to disk (no more 500MB buffer)",
      "status": "Merged"
    },
    {
      "id": "PR #34",
      "title": "§8 progreso: per-step WS on-progress (ComfyUI WebSocket progress)",
      "status": "Merged"
    },
    {
      "id": "PR #35",
      "title": "§8 SaveImage: stills saved as PNG directly (no more 1-frame mp4 + ffmpeg extract)",
      "status": "Merged (E2E validated)"
    },
    {
      "id": "PR #36",
      "title": "§1 capítulos (chapter markers) para el final deliverable",
      "status": "Merged"
    },
    {
      "id": "Already done",
      "title": "§8 presets rápidos (preset options) + §8 dedupe de uploads (+ #26)",
      "status": "Verified already implemented"
    },
    {
      "id": "Recommended against",
      "title": "Ken Burns parallel (orchestrator, Promise.all on renders)",
      "status": "RECOMMENDED AGAINST (low ROI: ffmpeg 1-2s/scene, GPU bottleneck is sequential ComfyUI)"
    }
  ],
  "blocked": [
    {
      "id": "§6",
      "title": "Documental con títeres (espiga: rig de títeres + música + voz)",
      "why_blocked": "El spike de §6 se hace en babybeast (192.168.1.60:8188, reachable). Falta verificar/provisar que tenga instalados los nodos InfiniteTalk (WanInfiniteTalkToVideo) y Qwen-Image-Edit-2509. Es una decisión de producto (nuevo caso de usar), no una mejora incremental.",
      "exit_criterion": "babybeast:8188/object_info responde con los nodos WanInfiniteTalkToVideo y Qwen-Image-Edit-2509 instalados. A partir de ahí se puede hacer el spike de lip-sync + rig de títere en babybeast."
    }
  ],
  "summary": {
    "total_prs": 21,
    "merged": 21,
    "test_count": 313,
    "fail": 0,
    "typecheck": "clean",
    "blocked": "§6 (InfiniteTalk + Qwen-Image-Edit en babybeast)"
  }
}
