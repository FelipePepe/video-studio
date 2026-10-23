import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import type { Job, JobStatus } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';

export interface JobsPageProps {
  /** `listJobs` to load the table, `getJob` for the retry options, `cancelJob` to stop queued/running jobs, `approveDraft` to retry failed/cancelled ones. */
  api: Pick<ApiClient, 'listJobs' | 'getJob' | 'cancelJob' | 'approveDraft' | 'deleteJob'>;
  /** Shows the job in the Pipeline tab (live progress, or the video when done). */
  onOpen?: (jobId: string) => void;
}

type Filter = 'all' | 'active' | 'done' | 'failed' | 'cancelled';

const FILTERS: { id: Filter; label: MessageKey; match(j: Job): boolean }[] = [
  { id: 'all', label: 'jobs.filter.all', match: () => true },
  { id: 'active', label: 'jobs.filter.active', match: (j) => j.status === 'queued' || j.status === 'running' },
  { id: 'done', label: 'jobs.filter.done', match: (j) => j.status === 'done' },
  { id: 'failed', label: 'jobs.filter.failed', match: (j) => j.status === 'failed' },
  { id: 'cancelled', label: 'jobs.filter.cancelled', match: (j) => j.status === 'cancelled' },
];

const STATUS_LABEL: Record<JobStatus, MessageKey> = {
  queued: 'jobs.status.queued',
  running: 'jobs.status.running',
  done: 'jobs.status.done',
  failed: 'jobs.status.failed',
  cancelled: 'jobs.status.cancelled',
};

const REFRESH_EVERY_MS = 5000;

function isActive(j: Job): boolean {
  return j.status === 'queued' || j.status === 'running';
}

export function JobsPage({ api, onOpen }: JobsPageProps) {
  const { t, lang } = useI18n();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Action-level failures (retry / cancel): shown even while the list is loaded. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [canceling, setCanceling] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const list = await api.listJobs();
      if (gen === generation.current) {
        setJobs(list);
        setError(null);
      }
    } catch {
      if (gen === generation.current) setError(t('jobs.error'));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // While any job is still moving we poll; otherwise we stay quiet.
  const anyActive = (jobs ?? []).some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load(), REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [anyActive, load]);

  // An armed "click again to confirm" auto-forgets if the user walks away.
  useEffect(() => {
    if (confirmDelete === null) return;
    const timer = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function cancel(id: string) {
    setCanceling(id);
    setActionError(null);
    try {
      await api.cancelJob(id);
    } catch {
      setActionError(t('jobs.cancelFailed'));
    } finally {
      setCanceling(null);
    }
    await load();
  }

  /** Delete a finished job (row + its workDir on disk). The draft is kept. */
  async function removeJob(id: string) {
    setConfirmDelete(null);
    setDeleting(id);
    setActionError(null);
    try {
      await api.deleteJob(id);
    } catch {
      setActionError(t('jobs.deleteFailed'));
    } finally {
      setDeleting(null);
    }
    await load();
  }

  /** Two-click safety: the first click arms the button, the second executes. */
  function onDelete(id: string) {
    if (deleting) return;
    if (confirmDelete === id) void removeJob(id);
    else setConfirmDelete(id);
  }

  /**
   * Retry a failed/cancelled job by re-approving its draft (the server allows exactly this)
   * and re-sending the options that job was rendered with (music, volume, subtitles, vertical
   * would otherwise be lost). The first SSE event (`queued` + `jobId`) is the server's
   * acceptance: we resolve on it and leave the rest of the stream running; the list poller
   * then observes the new job. Any rejection (HTTP error, network) is surfaced, so the
   * button never gets stuck on 'Retrying…'.
   */
  async function retryJob(job: Job) {
    setRetrying(job.id);
    setActionError(null);
    try {
      const previous = await api.getJob(job.id).catch(() => undefined);
      const options = previous?.options ?? undefined;
      await new Promise<void>((resolve, reject) => {
        void api
          .approveDraft(job.draftId, {
            onEvent: () => resolve(),
            body: options,
          })
          .catch(reject);
      });
    } catch {
      setActionError(t('jobs.retryFailed'));
    } finally {
      setRetrying(null);
    }
    await load();
  }

  const locale = lang === 'es' ? 'es-ES' : 'en-GB';
  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const matcher = FILTERS.find((f) => f.id === filter)!.match;
  const listed = (jobs ?? []).filter(matcher);
  const showEmpty = jobs !== null && jobs.length === 0;
  const showList = jobs !== null && jobs.length > 0;

  return (
    <div className="jobs">
      <header className="jobs__head">
        <h1 className="jobs__title">{t('jobs.title')}</h1>
        <div className="jobs__controls">
          <div className="segmented" role="group" aria-label={t('nav.label')}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="segmented__btn"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {t(f.label)}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--ghost" onClick={() => void load()}>
            {t('jobs.refresh')}
          </button>
        </div>
      </header>

      {error && !showList && (
        <div className="panel jobs__alert" role="alert">
          <p>{t('jobs.error')}</p>
          <button type="button" className="btn btn--primary" onClick={() => void load()}>
            {t('jobs.retry')}
          </button>
        </div>
      )}
      {actionError && (
        <div className="panel jobs__alert" role="alert">
          <p>{actionError}</p>
        </div>
      )}
      {jobs === null && !error && <p className="placeholder">{t('jobs.loading')}</p>}
      {showEmpty && (
        <p className="placeholder">
          {t('jobs.empty')} <a href="#pipeline">{t('nav.pipeline')}</a>
        </p>
      )}

      {showList && (
        <ul className="jobs__list">
          {listed.map((j) => {
            const active = isActive(j);
            const pct = Math.round(j.progress * 100);
            return (
              <li key={j.id} className="card job">
                <div className="job__main">
                  <div className="job__row">
                    <span className="job__status" data-status={j.status}>
                      {t(STATUS_LABEL[j.status])}
                    </span>
                    <code className="job__id">{j.id}</code>
                    <time className="job__created" dateTime={j.createdAt}>
                      {fmtDate(j.createdAt)}
                    </time>
                  </div>
                  {active && (
                    <div className="job__progress">
                      {j.stage && <span className="job__stage">{j.stage}</span>}
                      <div className="progress__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                        <div className="progress__fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="job__pct">{pct}%</span>
                    </div>
                  )}
                  {j.error && <p className="job__error">{j.error}</p>}
                </div>
                <div className="job__actions">
                  {onOpen && (
                    <button type="button" className="btn btn--ghost" onClick={() => onOpen(j.id)}>
                      {t('jobs.open')}
                    </button>
                  )}
                  {(j.status === 'failed' || j.status === 'cancelled') && (
                    <button
                      type="button"
                      className="btn"
                      disabled={retrying === j.id}
                      onClick={() => void retryJob(j)}
                    >
                      {retrying === j.id ? t('jobs.retrying') : t('jobs.retryJob')}
                    </button>
                  )}
                  {j.status === 'done' && (
                    <>
                      <a className="btn btn--primary" href={`/api/jobs/${encodeURIComponent(j.id)}/output`}>
                        {t('jobs.output')}
                      </a>
                      <a className="btn btn--ghost" href={`/api/jobs/${encodeURIComponent(j.id)}/output?variant=cover`}>
                        {t('jobs.cover')}
                      </a>
                    </>
                  )}
                  {active && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={canceling === j.id}
                      onClick={() => void cancel(j.id)}
                    >
                      {canceling === j.id ? t('jobs.cancelling') : t('jobs.cancel')}
                    </button>
                  )}
                  {!active && (
                    <button
                      type="button"
                      className={`btn btn--danger ${confirmDelete === j.id ? 'btn--danger--armed' : ''}`}
                      disabled={deleting === j.id}
                      onClick={() => onDelete(j.id)}
                    >
                      {deleting === j.id
                        ? t('jobs.deleting')
                        : confirmDelete === j.id
                          ? t('jobs.confirmDelete')
                          : t('jobs.delete')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
