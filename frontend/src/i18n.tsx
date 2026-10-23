import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'es' | 'en';

export const LANGUAGE_STORAGE_KEY = 'video-studio.lang';
export const DEFAULT_LANG: Lang = 'es';

const es = {
  'app.name': 'Video Studio',
  'nav.label': 'Navegación principal',
  'nav.pipeline': 'Pipeline',
  'nav.jobs': 'Trabajos',
  'jobs.title': 'Trabajos',
  'jobs.refresh': 'Actualizar',
  'jobs.loading': 'Cargando…',
  'jobs.empty': 'No hay trabajos todavía.',
  'jobs.error': 'No se pudieron cargar los trabajos.',
  'jobs.retry': 'Reintentar',
  'jobs.retryJob': 'Reintentar trabajo',
  'jobs.retrying': 'Reintentando…',
  'jobs.retryFailed': 'No se pudo relanzar',
  'jobs.filter.all': 'Todas',
  'jobs.filter.active': 'Activas',
  'jobs.filter.done': 'Hechas',
  'jobs.filter.failed': 'Fallidas',
  'jobs.filter.cancelled': 'Canceladas',
  'jobs.status.queued': 'En cola',
  'jobs.status.running': 'En curso',
  'jobs.status.done': 'Hecha',
  'jobs.status.failed': 'Fallido',
  'jobs.status.cancelled': 'Cancelada',
  'jobs.cancel': 'Cancelar',
  'jobs.cancelling': 'Cancelando…',
  'jobs.cancelFailed': 'No se pudo cancelar.',
  'jobs.output': 'Ver video',
  'jobs.cover': 'Portada',
  'sidebar.settings': 'Ajustes',
  'sidebar.language': 'Idioma',
  'lang.es': 'ES',
  'lang.en': 'EN',
  'pipeline.title': 'Pipeline',
  'pipeline.newVideo': 'Nuevo vídeo',
  'pipeline.reviewTitle': 'Revisión de la escaleta',
  'pipeline.failedAt': 'Falló en la etapa «{stage}»: {error}',
  'form.title': 'Nuevo vídeo',
  'form.sourceKind': 'Fuente',
  'form.sourceUrl': 'URL',
  'form.sourceText': 'Texto',
  'form.urlLabel': 'URL del artículo',
  'form.textLabel': 'Texto del artículo',
  'form.language': 'Idioma',
  'form.voiceA': 'Voz A',
  'form.voiceB': 'Voz B',
  'form.voice.male': 'Masculina',
  'form.voice.female': 'Femenina',
  'form.mix': '⇄ Mezclar',
  'form.submit': 'Generar',
  'form.drafting': 'Generando escaleta…',
  'guide.title': 'Cómo funciona',
  'guide.step1': 'El LLM redacta una escaleta a partir del artículo.',
  'guide.step2': 'Revisa y ajusta el guion escena por escena.',
  'guide.step3': 'Aprueba para renderizar el vídeo final.',
  'progress.title': 'Progreso',
  'progress.label': 'Progreso del renderizado',
  'progress.stages': 'Etapas',
  'progress.warnings': 'Avisos',
  'progress.cancel': 'Cancelar',
  'stage.tts': 'Voz (TTS)',
  'stage.images': 'Imágenes',
  'stage.transitions': 'Transiciones',
  'stage.assemble': 'Montaje',
  'stage.state.pending': 'pendiente',
  'stage.state.active': 'en curso',
  'stage.state.done': 'hecho',
  'stage.state.failed': 'fallido',
  'video.title': 'Vídeo',
  'video.placeholder': 'El vídeo aparecerá aquí',
  'video.download': 'Descargar',
  'video.retry': 'Reintentar',
  'review.scenes': 'Escenas',
  'review.approve': 'Aprobar y generar',
  'review.back': 'Volver',
  'escaleta.title': 'Escaleta',
  'editor.scene': 'Escena {n}',
  'editor.title': 'Título',
  'editor.narration': 'Narración',
  'editor.visualPrompt': 'Prompt visual',
  'editor.voice': 'Voz',
  'editor.up': 'Subir escena {n}',
  'editor.down': 'Bajar escena {n}',
  'editor.delete': 'Eliminar escena {n}',
  'editor.add': 'Añadir escena debajo de la escena {n}',
  'editor.addShort': 'Añadir escena',
  'editor.error.empty': 'No puede estar vacío',
  'editor.error.tooLong': 'Máximo {max} caracteres',
  'editor.moved': 'La escena {from} se movió a la posición {to}',
  'editor.added': 'Escena añadida en la posición {n}',
  'editor.deleted': 'Escena {n} eliminada',
  'review.save': 'Guardar',
  'review.options': 'Opciones de render',
  'review.music': 'Música de fondo',
  'review.musicTrack': 'Canción',
  'review.musicPath': 'Ruta del archivo',
  'review.musicVolume': 'Volumen de música',
  'review.subtitles': 'Subtítulos',
  'review.vertical': 'Vertical 9:16',
  'review.saving': 'Guardando…',
  'review.dirty': 'Cambios sin guardar',
  'review.invalid': 'Corrige los campos marcados antes de continuar.',
  'review.musicRequired': 'Selecciona una canción o escribe una ruta de audio.',
  'review.confirmTitle': 'Hay cambios sin guardar',
  'review.confirmBody': 'Si vuelves ahora se perderán los cambios de la escaleta.',
  'review.discard': 'Descartar cambios',
  'review.keepEditing': 'Seguir editando',
  'error.network': 'No se pudo conectar con el servidor',
  'error.conflict': 'Este borrador ya está aprobado o en curso. Vuelve atrás y genera uno nuevo.',
  'error.cancelled': 'El trabajo fue cancelado',
  'error.streamEnded': 'La conexión terminó antes de completar el vídeo',
  'error.noDraft': 'No hay borrador que aprobar',
  'error.noOutput': 'El vídeo terminó pero no se pudo localizar el archivo',
  'settings.title': 'Ajustes',
  'settings.comfyHost': 'URL de ComfyUI',
  'settings.ollamaHost': 'URL de Ollama',
  'settings.piperHost': 'Piper (tcp://host:puerto)',
  'settings.ollamaModel': 'Modelo de Ollama',
  'settings.ollamaModelHint': 'Los modelos disponibles se cargan de tu Ollama; si la lista llega vacía puedes escribir un nombre a mano.',
  'settings.loading': 'Cargando ajustes…',
  'settings.loadError': 'No se pudieron cargar los ajustes',
  'settings.save': 'Guardar',
  'settings.saving': 'Guardando…',
  'settings.cancel': 'Cancelar',
  'settings.saveError': 'No se pudieron guardar los ajustes',
} as const;

export type MessageKey = keyof typeof es;

const en: Record<MessageKey, string> = {
  'app.name': 'Video Studio',
  'nav.label': 'Main navigation',
  'nav.pipeline': 'Pipeline',
  'nav.jobs': 'Jobs',
  'jobs.title': 'Jobs',
  'jobs.refresh': 'Refresh',
  'jobs.loading': 'Loading…',
  'jobs.empty': 'No jobs yet.',
  'jobs.error': 'Could not load jobs.',
  'jobs.retry': 'Retry',
  'jobs.retryJob': 'Retry job',
  'jobs.retrying': 'Retrying…',
  'jobs.retryFailed': 'Could not retry',
  'jobs.filter.all': 'All',
  'jobs.filter.active': 'Active',
  'jobs.filter.done': 'Done',
  'jobs.filter.failed': 'Failed',
  'jobs.filter.cancelled': 'Cancelled',
  'jobs.status.queued': 'Queued',
  'jobs.status.running': 'Running',
  'jobs.status.done': 'Done',
  'jobs.status.failed': 'Failed',
  'jobs.status.cancelled': 'Cancelled',
  'jobs.cancel': 'Cancel',
  'jobs.cancelling': 'Cancelling…',
  'jobs.cancelFailed': 'Could not cancel the job.',
  'jobs.output': 'Watch video',
  'jobs.cover': 'Cover',
  'sidebar.settings': 'Settings',
  'sidebar.language': 'Language',
  'lang.es': 'ES',
  'lang.en': 'EN',
  'pipeline.title': 'Pipeline',
  'pipeline.newVideo': 'New video',
  'pipeline.reviewTitle': 'Script review',
  'pipeline.failedAt': 'Failed at the “{stage}” stage: {error}',
  'form.title': 'New video',
  'form.sourceKind': 'Source',
  'form.sourceUrl': 'URL',
  'form.sourceText': 'Text',
  'form.urlLabel': 'Article URL',
  'form.textLabel': 'Article text',
  'form.language': 'Language',
  'form.voiceA': 'Voice A',
  'form.voiceB': 'Voice B',
  'form.voice.male': 'Male',
  'form.voice.female': 'Female',
  'form.mix': '⇄ Mix',
  'form.submit': 'Generate',
  'form.drafting': 'Drafting script…',
  'guide.title': 'How it works',
  'guide.step1': 'The LLM drafts a script from the article.',
  'guide.step2': 'Review and tweak the script scene by scene.',
  'guide.step3': 'Approve to render the final video.',
  'progress.title': 'Progress',
  'progress.label': 'Render progress',
  'progress.stages': 'Stages',
  'progress.warnings': 'Warnings',
  'progress.cancel': 'Cancel',
  'stage.tts': 'Voice (TTS)',
  'stage.images': 'Images',
  'stage.transitions': 'Transitions',
  'stage.assemble': 'Assembly',
  'stage.state.pending': 'pending',
  'stage.state.active': 'in progress',
  'stage.state.done': 'done',
  'stage.state.failed': 'failed',
  'video.title': 'Video',
  'video.placeholder': 'The video will appear here',
  'video.download': 'Download',
  'video.retry': 'Retry',
  'review.scenes': 'Scenes',
  'review.approve': 'Approve and generate',
  'review.back': 'Back',
  'escaleta.title': 'Script',
  'editor.scene': 'Scene {n}',
  'editor.title': 'Title',
  'editor.narration': 'Narration',
  'editor.visualPrompt': 'Visual prompt',
  'editor.voice': 'Voice',
  'editor.up': 'Move scene {n} up',
  'editor.down': 'Move scene {n} down',
  'editor.delete': 'Delete scene {n}',
  'editor.add': 'Add scene below scene {n}',
  'editor.addShort': 'Add scene',
  'editor.error.empty': 'Must not be empty',
  'editor.error.tooLong': 'At most {max} characters',
  'editor.moved': 'Scene {from} moved to position {to}',
  'editor.added': 'Scene added at position {n}',
  'editor.deleted': 'Scene {n} deleted',
  'review.save': 'Save',
  'review.options': 'Render options',
  'review.music': 'Background music',
  'review.musicTrack': 'Track',
  'review.musicPath': 'File path',
  'review.musicVolume': 'Music volume',
  'review.subtitles': 'Subtitles',
  'review.vertical': 'Vertical 9:16',
  'review.saving': 'Saving…',
  'review.dirty': 'Unsaved changes',
  'review.invalid': 'Fix the highlighted fields to continue.',
  'review.musicRequired': 'Choose a track or type an audio file path.',
  'review.confirmTitle': 'You have unsaved changes',
  'review.confirmBody': 'If you go back now, your script changes will be lost.',
  'review.discard': 'Discard changes',
  'review.keepEditing': 'Keep editing',
  'error.network': 'Could not reach the server',
  'error.conflict': 'This draft is already approved or running. Go back and create a new one.',
  'error.cancelled': 'The job was cancelled',
  'error.streamEnded': 'The connection ended before the video was completed',
  'error.noDraft': 'There is no draft to approve',
  'error.noOutput': 'The video finished but its file could not be located',
  'settings.title': 'Settings',
  'settings.comfyHost': 'ComfyUI URL',
  'settings.ollamaHost': 'Ollama URL',
  'settings.piperHost': 'Piper (tcp://host:port)',
  'settings.ollamaModel': 'Ollama model',
  'settings.ollamaModelHint': 'Models are loaded from your Ollama; if the list is empty you can type a name manually.',
  'settings.loading': 'Loading settings…',
  'settings.loadError': 'Could not load settings',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.cancel': 'Cancel',
  'settings.saveError': 'Could not save settings',
};

export const dictionaries: Record<Lang, Record<MessageKey, string>> = { es, en };

/** Replaces `{name}` placeholders in a translated message. */
export function format(message: string, params: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m));
}

export interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

function isLang(value: unknown): value is Lang {
  return value === 'es' || value === 'en';
}

function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // Storage unavailable (private mode, blocked): fall back to the default.
  }
  return DEFAULT_LANG;
}

function writeStoredLang(lang: Lang): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Persistence is a convenience; the in-memory choice still applies.
  }
}

const defaultI18n: I18n = {
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key, params) => (params ? format(dictionaries[DEFAULT_LANG][key], params) : dictionaries[DEFAULT_LANG][key]),
};

const I18nContext = createContext<I18n>(defaultI18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writeStoredLang(next);
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => (params ? format(dictionaries[lang][key], params) : dictionaries[lang][key]),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
