import { useI18n, type MessageKey } from '../i18n';
import type { StageId, StageInfo, Substep } from '../hooks/usePipeline';

export interface ProgressStagesProps {
  stages: StageInfo[];
  /** 0–1 */
  progress: number;
  warnings: string[];
  /** ComfyUI step inside the active stage; renders a secondary bar. */
  substep?: Substep | null;
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

export function ProgressStages({ stages, progress, warnings, substep, cancellable, onCancel }: ProgressStagesProps) {
  const { t } = useI18n();
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const subPercent = substep ? Math.round(Math.min(1, Math.max(0, substep.value / substep.max)) * 100) : 0;
  const subLabel = substep ? t('progress.substep', { value: substep.value, max: substep.max }) : '';

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

      {substep && (
        <div className="progress__sub">
          <span className="progress__sub-label">{subLabel}</span>
          <div
            className="progress__bar progress__bar--sub"
            role="progressbar"
            aria-label={subLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={subPercent}
          >
            <div className="progress__fill" style={{ width: `${subPercent}%` }} />
          </div>
        </div>
      )}

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
