import { useI18n, type MessageKey } from '../i18n';
import type { StageId, StageInfo } from '../hooks/usePipeline';

export interface ProgressStagesProps {
  stages: StageInfo[];
  /** 0–1 */
  progress: number;
  warnings: string[];
  cancellable: boolean;
  onCancel: () => void;
}

const STAGE_LABEL: Record<StageId, MessageKey> = {
  tts: 'stage.tts',
  images: 'stage.images',
  transitions: 'stage.transitions',
  assemble: 'stage.assemble',
};

const STATE_LABEL: Record<StageInfo['status'], MessageKey> = {
  pending: 'stage.state.pending',
  active: 'stage.state.active',
  done: 'stage.state.done',
  failed: 'stage.state.failed',
};

export function ProgressStages({ stages, progress, warnings, cancellable, onCancel }: ProgressStagesProps) {
  const { t } = useI18n();
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <section className="panel progress" aria-label={t('progress.title')}>
      <h2>{t('progress.title')}</h2>
      <div
        className="progress__bar"
        role="progressbar"
        aria-label={t('progress.label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="progress__fill" style={{ width: `${percent}%` }} />
      </div>

      <ol className="stages" aria-label={t('progress.stages')}>
        {stages.map((s) => (
          <li
            key={s.id}
            className="stages__item"
            data-state={s.status}
            aria-current={s.status === 'active' ? 'step' : undefined}
          >
            <span className="stages__name">{t(STAGE_LABEL[s.id])}</span>
            <span className="stages__state">{t(STATE_LABEL[s.status])}</span>
          </li>
        ))}
      </ol>

      {warnings.length > 0 && (
        <div className="warnings">
          <h3>{t('progress.warnings')}</h3>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {cancellable && (
        <button type="button" className="btn" onClick={onCancel}>
          {t('progress.cancel')}
        </button>
      )}
    </section>
  );
}
