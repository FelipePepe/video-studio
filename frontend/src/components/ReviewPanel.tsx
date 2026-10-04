import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { DraftCreated, Escaleta } from '../api/types';
import { isEscaletaValid, sameEscaleta } from '../lib/escaleta';
import { SegmentEditor } from './SegmentEditor';

export interface ReviewPanelProps {
  draft: DraftCreated;
  /** Error from the last save attempt (shown in an alert). */
  error: string | null;
  onSave: (escaleta: Escaleta) => Promise<boolean>;
  onApprove: () => void;
  onBack: () => void;
}

export function ReviewPanel({ draft, error, onSave, onApprove, onBack }: ReviewPanelProps) {
  const { t } = useI18n();
  const reasonId = useId();
  const [local, setLocal] = useState<Escaleta>(draft.escaleta);
  const [syncedId, setSyncedId] = useState(draft.id);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The local copy belongs to one draft: start over when another one arrives.
  if (syncedId !== draft.id) {
    setSyncedId(draft.id);
    setLocal(draft.escaleta);
    setConfirming(false);
  }

  const dirty = useMemo(() => !sameEscaleta(local, draft.escaleta), [local, draft.escaleta]);
  const valid = useMemo(() => isEscaletaValid(local), [local]);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      return await onSave(local);
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (dirty && !(await save())) return;
    onApprove();
  };

  const back = () => (dirty ? setConfirming(true) : onBack());

  return (
    <section className="panel review" aria-label={t('pipeline.reviewTitle')}>
      <h2>{t('pipeline.reviewTitle')}</h2>
      <p className="review__count">
        {t('review.scenes')}: {local.length}
      </p>

      <div className="review__toolbar">
        <button type="button" className="btn" onClick={back} disabled={saving}>
          {t('review.back')}
        </button>
        {dirty && (
          <span className="review__dirty" role="status">
            {t('review.dirty')}
          </span>
        )}
        <span className="review__spacer" />
        <button type="button" className="btn" onClick={() => void save()} disabled={!dirty || !valid || saving}>
          {saving ? t('review.saving') : t('review.save')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void approve()}
          disabled={!valid || saving}
          aria-describedby={valid ? undefined : reasonId}
        >
          {t('review.approve')}
        </button>
      </div>
      {!valid && (
        <p id={reasonId} className="form-error">
          {t('review.invalid')}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}

      <SegmentEditor scenes={local} onChange={setLocal} />

      {confirming && (
        <ConfirmDialog
          title={t('review.confirmTitle')}
          body={t('review.confirmBody')}
          confirmLabel={t('review.discard')}
          cancelLabel={t('review.keepEditing')}
          onConfirm={onBack}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app confirmation (never `window.confirm`). Focus starts on the safe action; Escape cancels. */
function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div className="modal__actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
