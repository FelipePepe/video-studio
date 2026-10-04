import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'es' | 'en';

export const LANGUAGE_STORAGE_KEY = 'video-studio.lang';
export const DEFAULT_LANG: Lang = 'es';

const es = {
  'app.name': 'Video Studio',
  'nav.label': 'Navegación principal',
  'nav.pipeline': 'Pipeline',
  'nav.jobs': 'Trabajos',
  'nav.soon': 'próximamente',
  'sidebar.settings': '⚙ Ajustes',
  'sidebar.language': 'Idioma',
  'lang.es': 'ES',
  'lang.en': 'EN',
  'pipeline.placeholder': 'Pipeline — disponible en la siguiente tarea',
  'settings.title': 'Ajustes',
  'settings.comfyHost': 'URL de ComfyUI',
  'settings.ollamaHost': 'URL de Ollama',
  'settings.piperHost': 'Piper (tcp://host:puerto)',
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
  'nav.soon': 'coming soon',
  'sidebar.settings': '⚙ Settings',
  'sidebar.language': 'Language',
  'lang.es': 'ES',
  'lang.en': 'EN',
  'pipeline.placeholder': 'Pipeline — coming in the next task',
  'settings.title': 'Settings',
  'settings.comfyHost': 'ComfyUI URL',
  'settings.ollamaHost': 'Ollama URL',
  'settings.piperHost': 'Piper (tcp://host:port)',
  'settings.loading': 'Loading settings…',
  'settings.loadError': 'Could not load settings',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.cancel': 'Cancel',
  'settings.saveError': 'Could not save settings',
};

export const dictionaries: Record<Lang, Record<MessageKey, string>> = { es, en };

export interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey) => string;
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
  t: (key) => dictionaries[DEFAULT_LANG][key],
};

const I18nContext = createContext<I18n>(defaultI18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writeStoredLang(next);
  }, []);

  const value = useMemo<I18n>(
    () => ({ lang, setLang, t: (key) => dictionaries[lang][key] }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
