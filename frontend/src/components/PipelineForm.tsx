import { useId, useState, type FormEvent } from 'react';
import type { DraftRequest, Voice } from '../api/types';
import { useI18n } from '../i18n';

export interface PipelineFormProps {
  drafting: boolean;
  error: string | null;
  onSubmit: (req: DraftRequest) => void;
  /** Page-level guard: the pipeline owns the form while a run is in flight or finished. */
  disabled?: boolean;
}

type SourceKind = 'url' | 'text';
type Format = 'narration' | 'dialogue';

const VOICES = ['male', 'female'] as const;
/** Default presenter names suggested in dialogue mode. */
const DEFAULT_HOSTS = { a: 'Ana', b: 'Leo' };
const MAX_HOST_NAME = 40;

export function PipelineForm({ drafting, error, onSubmit, disabled = false }: PipelineFormProps) {
  const { t } = useI18n();
  const id = useId();
  const [source, setSource] = useState<SourceKind>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [language, setLanguage] = useState('es');
  const [voiceA, setVoiceA] = useState<Voice>('male');
  const [voiceB, setVoiceB] = useState<Voice>('female');
  const [mix, setMix] = useState(false);
  const [format, setFormat] = useState<Format>('narration');
  const [hostA, setHostA] = useState(DEFAULT_HOSTS.a);
  const [hostB, setHostB] = useState(DEFAULT_HOSTS.b);

  const value = (source === 'url' ? url : text).trim();
  const canSubmit = value !== '' && !drafting && !disabled;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const base = { ...(source === 'url' ? { url: value } : { text: value }), language, voiceA, voiceB, mix };
    // Narration mode keeps the payload exactly as before (no new keys).
    if (format === 'dialogue') {
      onSubmit({ ...base, format: 'dialogue', hosts: { a: hostA.trim(), b: hostB.trim() } });
    } else {
      onSubmit(base);
    }
  };

  const voiceOptions = VOICES.map((v) => (
    <option key={v} value={v}>
      {t(v === 'male' ? 'form.voice.male' : 'form.voice.female')}
    </option>
  ));

  return (
    <form className="panel form" noValidate onSubmit={handleSubmit} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('form.title')}</h2>

      <div className="segmented" role="group" aria-label={t('form.sourceKind')}>
        {(['url', 'text'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="segmented__btn"
            aria-pressed={source === kind}
            onClick={() => setSource(kind)}
          >
            {t(kind === 'url' ? 'form.sourceUrl' : 'form.sourceText')}
          </button>
        ))}
      </div>

      <div className="segmented" role="group" aria-label={t('form.format')}>
        {(['narration', 'dialogue'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className="segmented__btn"
            aria-pressed={format === f}
            onClick={() => setFormat(f)}
          >
            {t(f === 'narration' ? 'form.format.narration' : 'form.format.dialogue')}
          </button>
        ))}
      </div>

      {format === 'dialogue' && (
        <div className="form__voices">
          <div className="field">
            <label htmlFor={`${id}-host-a`}>{t('form.hostA')}</label>
            <input
              id={`${id}-host-a`}
              type="text"
              maxLength={MAX_HOST_NAME}
              value={hostA}
              onChange={(e) => setHostA(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-host-b`}>{t('form.hostB')}</label>
            <input
              id={`${id}-host-b`}
              type="text"
              maxLength={MAX_HOST_NAME}
              value={hostB}
              onChange={(e) => setHostB(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="field">
        {source === 'url' ? (
          <>
            <label htmlFor={`${id}-url`}>{t('form.urlLabel')}</label>
            <input id={`${id}-url`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </>
        ) : (
          <>
            <label htmlFor={`${id}-text`}>{t('form.textLabel')}</label>
            <textarea id={`${id}-text`} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          </>
        )}
      </div>

      <div className="field">
        <label htmlFor={`${id}-lang`}>{t('form.language')}</label>
        <select id={`${id}-lang`} value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="es">ES</option>
          <option value="en">EN</option>
        </select>
      </div>

      <div className="form__voices">
        <div className="field">
          <label htmlFor={`${id}-va`}>{t('form.voiceA')}</label>
          <select id={`${id}-va`} value={voiceA} onChange={(e) => setVoiceA(e.target.value)}>
            {voiceOptions}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-vb`}>{t('form.voiceB')}</label>
          <select id={`${id}-vb`} value={voiceB} onChange={(e) => setVoiceB(e.target.value)}>
            {voiceOptions}
          </select>
        </div>
        <button type="button" className="btn toggle" aria-pressed={mix} onClick={() => setMix((m) => !m)}>
          {t('form.mix')}
        </button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
        {drafting && <span className="spinner" aria-hidden="true" />}
        {drafting ? t('form.drafting') : t('form.submit')}
      </button>
    </form>
  );
}
