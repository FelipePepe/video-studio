import { useId, useState, type FormEvent } from 'react';
import type { DraftRequest, Voice } from '../api/types';
import { useI18n } from '../i18n';

export interface PipelineFormProps {
  drafting: boolean;
  error: string | null;
  onSubmit: (req: DraftRequest) => void;
}

type SourceKind = 'url' | 'text';

const VOICES = ['male', 'female'] as const;

export function PipelineForm({ drafting, error, onSubmit }: PipelineFormProps) {
  const { t } = useI18n();
  const id = useId();
  const [source, setSource] = useState<SourceKind>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [language, setLanguage] = useState('es');
  const [voiceA, setVoiceA] = useState<Voice>('male');
  const [voiceB, setVoiceB] = useState<Voice>('female');
  const [mix, setMix] = useState(false);

  const value = (source === 'url' ? url : text).trim();
  const canSubmit = value !== '' && !drafting;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({ ...(source === 'url' ? { url: value } : { text: value }), language, voiceA, voiceB, mix });
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
