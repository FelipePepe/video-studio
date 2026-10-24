import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type ApiClient, type ApproveBody } from '../api/client';
import type { DraftCreated, DraftRequest, JobEvent, Scene } from '../api/types';
import { log } from '../lib/logger';
import { useI18n } from '../i18n';

export type PipelineApi = Pick<
  ApiClient,
  'createDraft' | 'approveDraft' | 'cancelJob' | 'putSegments' | 'listMusic' | 'listVoices' | 'getJob' | 'getDraft' | 'watchJob' | 'listJobs'
>;

/** Survives tab switches and reloads: just enough to re-fetch the draft and re-follow its job. */
const STORAGE_KEY = 'vs.pipeline';
interface StoredPipeline {
  draftId: string;
  jobId?: string;
}

function readStored(): StoredPipeline | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPipeline>;
    if (typeof parsed.draftId !== 'string' || !parsed.draftId) return null;
    return { draftId: parsed.draftId, ...(typeof parsed.jobId === 'string' && parsed.jobId ? { jobId: parsed.jobId } : {}) };
  } catch {
    return null;
  }
}

function writeStored(value: StoredPipeline | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota): the pipeline still works, it just won't resume.
  }
}

export type PipelineState = 'idle' | 'drafting' | 'review' | 'rendering' | 'done' | 'failed';

export const STAGE_IDS = ['tts', 'images', 'transitions', 'assemble'] as const;
export type StageId = (typeof STAGE_IDS)[number];
export type StageStatus = 'pending' | 'active' | 'done' | 'failed';
export interface StageInfo {
  id: StageId;
  status: StageStatus;
}

export interface Substep {
  value: number;
  max: number;
}

export interface UsePipeline {
  state: PipelineState;
  draft: DraftCreated | null;
  error: string | null;
  stages: StageInfo[];
  progress: number;
  warnings: string[];
  substep: Substep | null;
  jobId: string | null;
  outputUrl: string | null;
  createDraft(req: DraftRequest): Promise<void>;
  saveSegments(escaleta: Scene[]): Promise<boolean>;
  approve(options?: { body?: ApproveBody }): Promise<void>;
  /** Loads an existing job (and its draft) into the pipeline view and follows its progress. */
  openJob(jobId: string): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}

const pendingStages = (): StageInfo[] => STAGE_IDS.map((id) => ({ id, status: 'pending' }));

function isStageId(value: unknown): value is StageId {
  return STAGE_IDS.includes(value as StageId);
}

export function usePipeline(api: PipelineApi): UsePipeline {
  const jobsLog = log.child('jobs');

  const { t } = useI18n();
  const [state, setStateRaw] = useState<PipelineState>('idle');
  const [draft, setDraft] = useState<DraftCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageInfo[]>(pendingStages);
  const [progress, setProgress] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [substep, setSubstep] = useState<Substep | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);

  // Mirrors `state` synchronously so guards can read it between renders.
  const stateRef = useRef<PipelineState>('idle');
  const setState = useCallback((next: PipelineState) => {
    stateRef.current = next;
    setStateRaw(next);
  }, []);
  // Generation counter: bumped on every approve() and reset() so stale streams are ignored.
  const runId = useRef(0);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const draftRef = useRef<DraftCreated | null>(null);
  const activeStage = useRef<StageId | null>(null);
  const terminal = useRef(false);
  // Bumped per openJob() so only the latest open wins while earlier ones are still loading.
  const openSeq = useRef(0);
  // True until the saved session (if any) has been re-opened; keeps the persist effect from wiping it.
  const restoring = useRef(false);
  const stored = useRef<StoredPipeline | null | undefined>(undefined);
  if (stored.current === undefined) {
    stored.current = readStored();
    restoring.current = stored.current !== null;
  }
  // Always the latest translator, so callbacks stay stable across language changes.
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Only stops listening; the backend job keeps running.
      controller.current?.abort();
    };
  }, []);

  const errorMessage = (e: unknown): string => {
    if (e instanceof ApiError) return e.message;
    return tRef.current('error.network');
  };

  const createDraft = useCallback(
    async (req: DraftRequest) => {
      if (stateRef.current !== 'idle') return;
      setError(null);
      setState('drafting');
      try {
        const created = await api.createDraft(req);
        if (!mounted.current) return;
        draftRef.current = created;
        setDraft(created);
        jobsLog.info('draft created', { draftId: created.id });
        setState('review');
      } catch (e) {
        if (!mounted.current) return;
        jobsLog.error('draft creation failed', { err: e as Error });
        setError(errorMessage(e));
        setState('idle');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, setState],
  );

  const saveSegments = useCallback(
    async (escaleta: Scene[]): Promise<boolean> => {
      const current = draftRef.current;
      if (!current) {
        setError(tRef.current('error.noDraft'));
        return false;
      }
      setError(null);
      try {
        const saved = await api.putSegments(current.id, escaleta);
        jobsLog.info('segments saved', { draftId: current.id, scenes: escaleta.length });
        if (!mounted.current || draftRef.current?.id !== current.id) return false;
        const next = { ...current, escaleta: saved.escaleta };
        draftRef.current = next;
        setDraft(next);
        return true;
      } catch (e) {
        if (mounted.current) {
          jobsLog.warn('saving segments failed', { draftId: current.id, err: e as Error });
          setError(errorMessage(e));
        }
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  const applyEvent = useCallback((event: JobEvent) => {
    if (event.type === 'done') jobsLog.info('job done', { jobId: event.jobId, outputUrl: event.outputUrl });
    else if (event.type === 'error') jobsLog.error('job error event', { jobId: event.jobId, stage: event.stage, message: event.message });
    else if (event.type === 'cancelled') jobsLog.warn('job cancelled', { jobId: event.jobId });
    if (!mounted.current || terminal.current) return;
    if (event.jobId) {
      jobIdRef.current = event.jobId;
      setJobId(event.jobId);
    }
    const stage = event.stage;
    if (isStageId(stage) && (event.type === 'stage' || event.type === 'progress')) {
      activeStage.current = stage;
      const idx = STAGE_IDS.indexOf(stage);
      setStages((prev) =>
        prev.map((s, i) => ({
          id: s.id,
          status: s.status === 'failed' ? 'failed' : i < idx ? 'done' : i === idx ? 'active' : s.status === 'done' ? 'done' : 'pending',
        })),
      );
    }
    if (typeof event.progress === 'number') {
      const value = Math.min(1, Math.max(0, event.progress));
      setProgress((p) => Math.max(p, value));
    }
    if (event.type === 'stage') setSubstep(null);
    else if (event.type === 'progress' && event.substep) setSubstep(event.substep);
    if ((event.type === 'stage' || event.type === 'progress') && event.message) {
      const message = event.message;
      setWarnings((w) => (w.includes(message) ? w : [...w, message]));
    }
    if (event.type === 'done') {
      terminal.current = true;
      setSubstep(null);
      const url = event.outputUrl || (jobIdRef.current ? `/api/jobs/${jobIdRef.current}/output` : null);
      if (!url) {
        setError(tRef.current('error.noOutput'));
        setState('failed');
        return;
      }
      setStages((prev) => prev.map((s) => ({ id: s.id, status: 'done' })));
      setProgress(1);
      setOutputUrl(url);
      setState('done');
    } else if (event.type === 'error' || event.type === 'cancelled') {
      terminal.current = true;
      setSubstep(null);
      const active = activeStage.current;
      setStages((prev) => prev.map((s) => (s.id === active ? { id: s.id, status: 'failed' } : s)));
      setError(event.message || (event.type === 'cancelled' ? tRef.current('error.cancelled') : tRef.current('error.network')));
      setState('failed');
    }
  }, [setState]);

  /** Claims the pipeline view for a new stream: aborts the previous one and resets progress state. */
  const startRun = useCallback(() => {
    controller.current?.abort();
    const run = ++runId.current;
    const ctrl = new AbortController();
    controller.current = ctrl;
    terminal.current = false;
    activeStage.current = null;
    jobIdRef.current = null;
    setError(null);
    setStages(pendingStages());
    setProgress(0);
    setWarnings([]);
    setSubstep(null);
    setJobId(null);
    setOutputUrl(null);
    setState('rendering');
    return { ctrl, isStale: () => run !== runId.current };
  }, [setState]);

  /** Feeds a job event stream into `applyEvent`; a stream that ends without a terminal event is a failure. */
  const consume = useCallback(
    async (
      run: { ctrl: AbortController; isStale: () => boolean },
      stream: (onEvent: (event: JobEvent) => void, signal: AbortSignal) => Promise<unknown>,
      what: string,
    ) => {
      try {
        await stream((event) => {
          if (!run.isStale()) applyEvent(event);
        }, run.ctrl.signal);
        jobsLog.info(`${what}: stream ended`);
        if (!mounted.current || run.isStale() || run.ctrl.signal.aborted || terminal.current) return;
        terminal.current = true;
        setError(tRef.current('error.streamEnded'));
        setState('failed');
      } catch (e) {
        if (!mounted.current || run.isStale() || run.ctrl.signal.aborted || terminal.current) return;
        jobsLog.error(`${what} failed`, { conflict: e instanceof ApiError && e.status === 409, err: e as Error });
        terminal.current = true;
        setError(e instanceof ApiError && e.status === 409 ? tRef.current('error.conflict') : errorMessage(e));
        setState('failed');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyEvent, setState],
  );

  const approve = useCallback(
    async (options?: { body?: ApproveBody }) => {
      const current = draftRef.current;
      if (!current) {
        setError(tRef.current('error.noDraft'));
        return;
      }
      const run = startRun();
      await consume(
        run,
        (onEvent, signal) => api.approveDraft(current.id, { onEvent, signal, body: options?.body }),
        `approve draft ${current.id}`,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, startRun, consume],
  );

  /** Fetches job + draft and claims the view; resolves before the stream is followed. Null on failure. */
  const loadJob = useCallback(
    async (id: string) => {
      const seq = ++openSeq.current;
      try {
        const job = await api.getJob(id);
        const full = await api.getDraft(job.draftId);
        if (!mounted.current || seq !== openSeq.current) return null;
        const loaded = { id: full.id, escaleta: full.escaleta, status: full.status };
        draftRef.current = loaded;
        setDraft(loaded);
        const run = startRun();
        jobIdRef.current = job.id;
        setJobId(job.id);
        jobsLog.info('job opened', { jobId: job.id, draftId: job.draftId });
        return { job, run };
      } catch (e) {
        if (mounted.current && seq === openSeq.current) {
          jobsLog.warn('opening job failed', { jobId: id, err: e as Error });
          setError(errorMessage(e));
        }
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, startRun],
  );

  const follow = useCallback(
    (loaded: NonNullable<Awaited<ReturnType<typeof loadJob>>>) =>
      consume(loaded.run, (onEvent, signal) => api.watchJob(loaded.job.id, { onEvent, signal }), `watch job ${loaded.job.id}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, consume],
  );

  const openJob = useCallback(
    async (id: string) => {
      if (jobIdRef.current === id && (stateRef.current === 'rendering' || stateRef.current === 'done')) return;
      const loaded = await loadJob(id);
      if (loaded) await follow(loaded);
    },
    [loadJob, follow],
  );

  /** Newest job of a draft (the list is newest first and has no draft filter); undefined if none or on failure. */
  const latestJobId = async (draftId: string): Promise<string | undefined> => {
    try {
      const jobs = await api.listJobs({ limit: 200 });
      return jobs.find((j) => j.draftId === draftId)?.id;
    } catch {
      return undefined;
    }
  };

  // Re-open the saved session once on mount (reload): a running/finished job, or a draft in review.
  useEffect(() => {
    const saved = stored.current;
    if (!saved || stateRef.current !== 'idle') {
      restoring.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      let ok = false;
      const resume = async (jobId: string): Promise<boolean> => {
        const loaded = await loadJob(jobId);
        if (!loaded) return false;
        ok = true;
        restoring.current = false;
        await follow(loaded);
        return true;
      };
      try {
        if (saved.jobId) {
          await resume(saved.jobId);
        } else {
          const full = await api.getDraft(saved.draftId);
          if (cancelled || !mounted.current || stateRef.current !== 'idle') return;
          // approve marks the draft approved in the same transaction that creates the job, i.e. before the
          // first event can hand us a jobId: an approved draft means a job exists, so follow it, not review.
          const jobId = full.status === 'approved' ? await latestJobId(full.id) : undefined;
          if (cancelled || !mounted.current || stateRef.current !== 'idle') return;
          if (jobId && (await resume(jobId))) return;
          const loaded = { id: full.id, escaleta: full.escaleta, status: full.status };
          draftRef.current = loaded;
          setDraft(loaded);
          setState('review');
          ok = true;
        }
      } catch {
        // Stale session (draft deleted, server down): fall through to the empty view.
      } finally {
        restoring.current = false;
        if (!ok && !cancelled) writeStored(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (restoring.current) return;
    if (!draft || state === 'idle' || state === 'drafting') {
      writeStored(null);
      return;
    }
    writeStored({ draftId: draft.id, ...(jobId ? { jobId } : {}) });
  }, [state, draft, jobId]);

  const cancel = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    try {
      await api.cancelJob(id);
    } catch (e) {
      if (mounted.current) {
        jobsLog.warn('cancel failed', { jobId: id, err: e as Error });
        setError(errorMessage(e));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const reset = useCallback(() => {
    runId.current += 1;
    controller.current?.abort();
    controller.current = null;
    draftRef.current = null;
    jobIdRef.current = null;
    terminal.current = false;
    setDraft(null);
    setError(null);
    setStages(pendingStages());
    setProgress(0);
    setWarnings([]);
    setSubstep(null);
    setJobId(null);
    setOutputUrl(null);
    setState('idle');
  }, [setState]);

  return useMemo(
    () => ({ state, draft, error, stages, progress, warnings, substep, jobId, outputUrl, createDraft, saveSegments, approve, openJob, cancel, reset }),
    [state, draft, error, stages, progress, warnings, substep, jobId, outputUrl, createDraft, saveSegments, approve, openJob, cancel, reset],
  );
}
