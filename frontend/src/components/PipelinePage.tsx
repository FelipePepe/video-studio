import { useI18n } from '../i18n';
import type { PipelineApi, UsePipeline } from '../hooks/usePipeline';
import type { ApiClient } from '../api/client';
import { EscaletaCards } from './EscaletaCards';
import { GuideCard } from './GuideCard';
import { PipelineForm } from './PipelineForm';
import { ProgressStages } from './ProgressStages';
import { ReviewPanel } from './ReviewPanel';
import { VideoPanel } from './VideoPanel';

export interface PipelinePageProps {
  api: PipelineApi;
  /** Owned by App so the pipeline survives tab switches. */
  pipeline: UsePipeline;
}

export function PipelinePage({ api, pipeline: p }: PipelinePageProps) {
  const { t } = useI18n();
  const rendering = p.state === 'rendering';
  const showProgress = rendering || p.state === 'done' || p.state === 'failed';

  // F4: on a failed run, name the failed stage next to the error.
  const failedStage = p.stages.find((s) => s.status === 'failed');
  const reviewError =
    p.state === 'failed' && p.error && failedStage
      ? t('pipeline.failedAt', { stage: t(`stage.${failedStage.id}`), error: p.error })
      : p.error;
  return (
    <div className="pipeline">
      <h1 className="pipeline__title">{t('pipeline.title')}</h1>

      {((p.state === 'review' || p.state === 'failed') && p.draft) ? (
        <ReviewPanel draft={p.draft} api={api} error={reviewError} onSave={p.saveSegments} onApprove={(body) => void p.approve({ body })} onBack={p.reset} />
      ) : (
        <div className="pipeline__grid">
          <div className="pipeline__form">
            <PipelineForm
              drafting={p.state === 'drafting'}
              error={p.state === 'idle' || p.state === 'drafting' ? p.error : null}
              disabled={p.state !== 'idle' && p.state !== 'drafting'}
              onSubmit={(req) => void p.createDraft(req)}
            />
            {p.state === 'idle' && <GuideCard />}
            {showProgress && (
              <ProgressStages
                stages={p.stages}
                progress={p.progress}
                warnings={p.warnings}
                substep={p.substep}
                cancellable={rendering}
                onCancel={() => void p.cancel()}
              />
            )}
            {p.state === 'done' && (
              <button type="button" className="btn btn--primary" onClick={() => p.reset()}>
                {t('pipeline.newVideo')}
              </button>
            )}
          </div>
          <div className="pipeline__video">
            <VideoPanel state={p.state} outputUrl={p.outputUrl} error={p.error} onRetry={() => void p.approve()} />
          </div>
          {p.draft && (
            <div className="pipeline__escaleta">
              <EscaletaCards escaleta={p.draft.escaleta} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
