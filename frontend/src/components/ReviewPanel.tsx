import { useI18n } from '../i18n';
import type { DraftCreated } from '../api/types';

export interface ReviewPanelProps {
  draft: DraftCreated;
  onApprove: () => void;
  onBack: () => void;
}

/** Extension point (T4c replaces the body with the segment editor). */
export function ReviewPanel({ draft, onApprove, onBack }: ReviewPanelProps) {
  const { t } = useI18n();
  return (
    <section className="panel review" aria-label={t('pipeline.reviewTitle')}>
      <h2>{t('pipeline.reviewTitle')}</h2>
      <p>
        {t('review.scenes')}: {draft.escaleta.length}
      </p>
      <div className="review__actions">
        <button type="button" className="btn" onClick={onBack}>
          {t('review.back')}
        </button>
        <button type="button" className="btn btn--primary" onClick={onApprove}>
          {t('review.approve')}
        </button>
      </div>
    </section>
  );
}
