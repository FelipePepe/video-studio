import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import type { DraftCreated, DraftRequest, JobEvent, Scene } from '../api/types';
import { useI18n } from '../i18n';

export type PipelineApi = Pick<ApiClient, 'createDraft' | 'approveDraft' | 'cancelJob' | 'putSegments'>;

export type PipelineState = 'idle' | 'drafting' | 'review' | 'rendering' | 'done' | 'failed';

export const STAGE_IDS = ['tts', 'images', 'transitions', 'assemble'] as const;
export type StageId = (typeof STAGE_IDS)[number];
export type StageStatus = 'pending' | 'active' | 'done' | 'failed';
export interface StageInfo {
  id: StageId;
  status: StageStatus;
}

export interface UsePipeline {
  state: PipelineState;
  draft: DraftCreated | null;
  error: string | null;
  stages: StageInfo[];
  progress: number;
  warnings: string[];
  jobId: string | null;
  outputUrl: string | null;
  createDraft(req: DraftRequest): Promise<void>;
  saveSegments(escaleta: Scene[]): Promise<boolean>;
  approve(): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}

const pendingStages = (): StageInfo[] => STAGE_IDS.map((id) => ({ id, status: 'pending' }));

function isStageId(value: unknown): value is StageId {
  return STAGE_IDS.includes(value as StageId);
}

export function usePipeline(api: PipelineApi): UsePipeline {
  const { t } = useI18n();
  const [state, setStateRaw] = useState<PipelineState>('idle');
  const [draft, setDraft] = useState<DraftCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageInfo[]>(pendingStages);
  const [progress, setProgress] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
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
        setState('review');
      } catch (e) {
        if (!mounted.current) return;
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
        if (!mounted.current || draftRef.current?.id !== current.id) return false;
        const next = { ...current, escaleta: saved.escaleta };
        draftRef.current = next;
        setDraft(next);
        return true;
      } catch (e) {
        if (mounted.current) setError(errorMessage(e));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  const applyEvent = useCallback((event: JobEvent) => {
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
    if ((event.type === 'stage' || event.type === 'progress') && event.message) {
      const message = event.message;
      setWarnings((w) => (w.includes(message) ? w : [...w, message]));
    }
    if (event.type === 'done') {
      terminal.current = true;
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
      const active = activeStage.current;
      setStages((prev) => prev.map((s) => (s.id === active ? { id: s.id, status: 'failed' } : s)));
      setError(event.message || (event.type === 'cancelled' ? tRef.current('error.cancelled') : tRef.current('error.network')));
      setState('failed');
    }
  }, [setState]);

  const approve = useCallback(async () => {
    const current = draftRef.current;
    if (!current) {
      setError(tRef.current('error.noDraft'));
      return;
    }
    controller.current?.abort();
    const run = ++runId.current;
    const isStale = () => run !== runId.current;
    const ctrl = new AbortController();
    controller.current = ctrl;
    terminal.current = false;
    activeStage.current = null;
    jobIdRef.current = null;
    setError(null);
    setStages(pendingStages());
    setProgress(0);
    setWarnings([]);
    setJobId(null);
    setOutputUrl(null);
    setState('rendering');
    try {
      await api.approveDraft(current.id, {
        onEvent: (event) => {
          if (!isStale()) applyEvent(event);
        },
        signal: ctrl.signal,
      });
      if (!mounted.current || isStale() || ctrl.signal.aborted || terminal.current) return;
      terminal.current = true;
      setError(tRef.current('error.streamEnded'));
      setState('failed');
    } catch (e) {
      if (!mounted.current || isStale() || ctrl.signal.aborted || terminal.current) return;
      terminal.current = true;
      setError(e instanceof ApiError && e.status === 409 ? tRef.current('error.conflict') : errorMessage(e));
      setState('failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, applyEvent, setState]);

  const cancel = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    try {
      await api.cancelJob(id);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
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
    setJobId(null);
    setOutputUrl(null);
    setState('idle');
  }, [setState]);

  return useMemo(
    () => ({ state, draft, error, stages, progress, warnings, jobId, outputUrl, createDraft, saveSegments, approve, cancel, reset }),
    [state, draft, error, stages, progress, warnings, jobId, outputUrl, createDraft, saveSegments, approve, cancel, reset],
  );
}
