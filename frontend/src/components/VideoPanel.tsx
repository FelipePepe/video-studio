import { useI18n } from '../i18n';
import type { PipelineState } from '../hooks/usePipeline';

export interface VideoPanelProps {
  state: PipelineState;
  outputUrl: string | null;
  error: string | null;
  onRetry: () => void;
}

export function VideoPanel({ state, outputUrl, error, onRetry }: VideoPanelProps) {
  const { t } = useI18n();

  if (state === 'done' && outputUrl) {
    return (
      <section className="panel video" aria-label={t('video.title')}>
        <video className="video__player" controls src={outputUrl} />
        <a className="btn" href={outputUrl} download>
          {t('video.download')}
        </a>
      </section>
    );
  }

  return (
    <section className="panel video" aria-label={t('video.title')}>
      <div className="video__placeholder">{t('video.placeholder')}</div>
      {state === 'failed' && (
        <div className="video__failed">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            {t('video.retry')}
          </button>
        </div>
      )}
    </section>
  );
}
