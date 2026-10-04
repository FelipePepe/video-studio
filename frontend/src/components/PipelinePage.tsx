import { useI18n } from '../i18n';
import { usePipeline, type PipelineApi } from '../hooks/usePipeline';
import { EscaletaCards } from './EscaletaCards';
import { GuideCard } from './GuideCard';
import { PipelineForm } from './PipelineForm';
import { ProgressStages } from './ProgressStages';
import { ReviewPanel } from './ReviewPanel';
import { VideoPanel } from './VideoPanel';

export interface PipelinePageProps {
  api: PipelineApi;
}

export function PipelinePage({ api }: PipelinePageProps) {
  const { t } = useI18n();
  const p = usePipeline(api);
  const rendering = p.state === 'rendering';
  const showProgress = rendering || p.state === 'done' || p.state === 'failed';

  return (
    <div className="pipeline">
      <h1 className="pipeline__title">{t('pipeline.title')}</h1>

      {p.state === 'review' && p.draft ? (
        <ReviewPanel draft={p.draft} onApprove={() => void p.approve()} onBack={p.reset} />
      ) : (
        <div className="pipeline__grid">
          <div className="pipeline__form">
            <PipelineForm
              drafting={p.state === 'drafting'}
              error={p.state === 'idle' || p.state === 'drafting' ? p.error : null}
              onSubmit={(req) => void p.createDraft(req)}
            />
            {p.state === 'idle' && <GuideCard />}
            {showProgress && (
              <ProgressStages
                stages={p.stages}
                progress={p.progress}
                warnings={p.warnings}
                cancellable={rendering}
                onCancel={() => void p.cancel()}
              />
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
