import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { ApiClient, ApproveBody } from '../api/client';
import { ApiError } from '../api/client';
import type { DraftCreated, Escaleta, MusicLibrary } from '../api/types';
import { isEscaletaValid, sameEscaleta } from '../lib/escaleta';
import { SegmentEditor } from './SegmentEditor';

export interface ReviewPanelProps {
  draft: DraftCreated;
  /** Full client surface used for the render options (music library + Piper roster). May be a minimal fake. */
  api: Pick<ApiClient, 'listMusic' | 'listVoices'>;
  /** Error from the last save attempt (shown in an alert). */
  error: string | null;
  onSave: (escaleta: Escaleta) => Promise<boolean>;
  onApprove: (options?: ApproveBody) => void;
  onBack: () => void;
}

const DEFAULT_MUSIC_VOLUME = 0.25;

function useMusicLibrary(api: ReviewPanelProps['api']): MusicLibrary | null | undefined {
  const [lib, setLib] = useState<MusicLibrary | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api
      .listMusic()
      .then((l) => {
        if (alive) setLib(l);
      })
      .catch(() => {
        if (alive) setLib(null);
      });
    return () => {
      alive = false;
    };
  }, [api]);
  return lib;
}

/** Voices for the segment editor: roster when the Piper server answers, else the male/female fallback. */
export function useVoices(api: ReviewPanelProps['api']): string[] {
  const [voices, setVoices] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .listVoices()
      .then((r) => {
        if (alive) setVoices(r.map((v) => v.name));
      })
      .catch(() => {
        if (alive) setVoices([]);
      });
    return () => {
      alive = false;
    };
  }, [api]);
  const fallback = ['male', 'female'];
  return voices === null ? fallback : voices.length > 0 ? voices : fallback;
}

export function ReviewPanel({ draft, api, error, onSave, onApprove, onBack }: ReviewPanelProps) {
  const { t } = useI18n();
  const baseId = useId();
  const reasonId = useId();
  const [local, setLocal] = useState<Escaleta>(draft.escaleta);
  const [syncedId, setSyncedId] = useState(draft.id);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Render options (approve body delta: only non-defaults are sent).
  const [musicOn, setMusicOn] = useState(false);
  const [musicCustom, setMusicCustom] = useState(false);
  const [musicPath, setMusicPath] = useState('');
  const [musicVolume, setMusicVolume] = useState(DEFAULT_MUSIC_VOLUME);
  const [subtitles, setSubtitles] = useState(true);
  const [vertical, setVertical] = useState(false);
  const library = useMusicLibrary(api);
  const voices = useVoices(api);

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
    const body: ApproveBody = {};
    if (musicOn) {
      const track = library?.files.find((f) => f.path === musicPath);
      const path = track ? track.path : musicPath.trim();
      if (!path) return; // nothing to mix with: the backend would 400
      body.music = path;
      body.musicVolume = musicVolume;
    }
    if (!subtitles) body.subtitles = false; // ON is the backend default
    if (vertical) body.vertical = true; // OFF is the backend default
    onApprove(Object.keys(body).length > 0 ? body : undefined);
  };

  const back = () => (dirty ? setConfirming(true) : onBack());

  return (
    <section className="panel review" aria-label={t('pipeline.reviewTitle')}>
      <h2>{t('pipeline.reviewTitle')}</h2>
      <p className="review__count">
        {t('review.scenes')}: {local.length}
      </p>

      <fieldset className="render-options" aria-label={t('review.options')}>
        <legend>{t('review.options')}</legend>

        <div className="render-options__row">
          <label className="switch" htmlFor={`${baseId}-music`}>{t('review.music')}</label>
          <input id={`${baseId}-music`} className="switch__input" type="checkbox" role="switch" checked={musicOn} onChange={(e) => setMusicOn(e.target.checked)} />
        </div>

        {musicOn && (
          <div className="render-options__music">
            {library !== null && library !== undefined && library.files.length > 0 ? (
              <div className="field field--inline">
                <label htmlFor={`${baseId}-musicTrack`}>{t('review.musicTrack')}</label>
                <select id={`${baseId}-musicTrack`} value={musicPath} onChange={(e) => setMusicPath(e.target.value)}>
                  {library.files.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field field--inline">
                <label htmlFor={`${baseId}-musicPath`}>{t('review.musicPath')}</label>
                <input id={`${baseId}-musicPath`} type="text" value={musicPath} onChange={(e) => setMusicPath(e.target.value)} />
              </div>
            )}
            <div className="field field--inline">
              <label htmlFor={`${baseId}-musicVolume`}>{t('review.musicVolume')}</label>
              <input
                id={`${baseId}-musicVolume`}
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={musicVolume}
                onChange={(e) => setMusicVolume(Number(e.target.value))}
              />
            </div>
          </div>
        )}

        <div className="render-options__row">
          <label className="switch" htmlFor={`${baseId}-subtitles`}>{t('review.subtitles')}</label>
          <input id={`${baseId}-subtitles`} className="switch__input" type="checkbox" role="switch" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />
        </div>

        <div className="render-options__row">
          <label className="switch" htmlFor={`${baseId}-vertical`}>{t('review.vertical')}</label>
          <input id={`${baseId}-vertical`} className="switch__input" type="checkbox" role="switch" checked={vertical} onChange={(e) => setVertical(e.target.checked)} />
        </div>
      </fieldset>

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

      <SegmentEditor scenes={local} onChange={setLocal} voices={voices} />

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
