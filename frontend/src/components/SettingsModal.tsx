import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApiClient } from '../api/client';
import type { Settings } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';

export interface SettingsModalProps {
  api: Pick<ApiClient, 'getConfig' | 'patchConfig' | 'listModels'>;
  onClose: () => void;
}

const FIELDS: { key: keyof Settings; label: MessageKey; placeholder: string }[] = [
  { key: 'comfyHost', label: 'settings.comfyHost', placeholder: 'http://host:8188' },
  { key: 'ollamaHost', label: 'settings.ollamaHost', placeholder: 'http://host:11434' },
  { key: 'piperHost', label: 'settings.piperHost', placeholder: 'tcp://host:10200' },
];

const FOCUSABLE = 'input, button, [href], [tabindex]:not([tabindex="-1"])';

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function SettingsModal({ api, onClose }: SettingsModalProps) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [values, setValues] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  // Focus management: move focus into the dialog, give it back to the opener on unmount.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((config) => {
        if (cancelled) return;
        setSaved(config);
        setValues(config);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e, t('settings.loadError')));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const modelsId = `${titleId}-ollamaModel`;

  // Load available Ollama models into the select, but never block the dialog on it.
  useEffect(() => {
    let cancelled = false;
    api.listModels().then((list) => {
      if (!cancelled) setOllamaModels(list);
    }).catch(() => {
      if (!cancelled) setOllamaModels([]);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const changed: Partial<Settings> = {};
  if (saved && values) {
    for (const { key } of FIELDS) if (values[key] !== saved[key]) changed[key] = values[key];
    if (values.ollamaModel !== saved.ollamaModel) changed.ollamaModel = values.ollamaModel;
  }
  const dirty = Object.keys(changed).length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patchConfig(changed);
      onClose();
    } catch (err) {
      setSaveError(errorMessage(err, t('settings.saveError')));
      setSaving(false);
    }
  }

  // Keep Tab inside the dialog.
  function trapTab(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !(el as HTMLButtonElement).disabled,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <h2 id={titleId}>{t('settings.title')}</h2>

        {loadError && <p role="alert" className="form-error">{loadError}</p>}
        {!values && !loadError && <p>{t('settings.loading')}</p>}

        {values && (
          <form onSubmit={submit}>
            {FIELDS.map(({ key, label, placeholder }) => (
              <div className="field" key={key}>
                <label htmlFor={`${titleId}-${key}`}>{t(label)}</label>
                <input
                  id={`${titleId}-${key}`}
                  type="text"
                  value={values[key]}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="field">
              <label htmlFor={modelsId}>{t('settings.ollamaModel')}</label>
              {ollamaModels.length > 0 ? (
                <select
                  id={modelsId}
                  value={values.ollamaModel}
                  onChange={(e) => setValues({ ...values, ollamaModel: e.target.value })}
                >
                  {ollamaModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    id={modelsId}
                    type="text"
                    value={values.ollamaModel}
                    placeholder="qwen3:8b / llama3.2:3b"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setValues({ ...values, ollamaModel: e.target.value })}
                  />
                  <p className="field__hint">{t('settings.ollamaModelHint')}</p>
                </>
              )}
            </div>
            {saveError && <p role="alert" className="form-error">{saveError}</p>}
            <div className="modal__actions">
              <button type="button" className="btn" onClick={onClose}>
                {t('settings.cancel')}
              </button>
              <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
                {saving ? t('settings.saving') : t('settings.save')}
              </button>
            </div>
          </form>
        )}

        {!values && loadError && (
          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose}>
              {t('settings.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
