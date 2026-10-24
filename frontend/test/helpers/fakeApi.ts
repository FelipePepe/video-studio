import { vi } from 'vitest';
import type { ApiClient, ApproveOptions } from '../../src/api/client';
import type { Draft, DraftCreated, Escaleta, Job, JobEvent, MusicLibrary, VoiceOption } from '../../src/api/types';

export const draft: DraftCreated = {
  id: 'd1',
  status: 'draft',
  escaleta: [
    { scene: 1, title: 'Intro', narration: 'Hello', visualPrompt: 'a', voice: 'male' },
    { scene: 2, title: 'Body', narration: 'World', visualPrompt: 'b', voice: 'female' },
  ],
};

export type PipelineApi = Pick<
  ApiClient,
  'createDraft' | 'approveDraft' | 'cancelJob' | 'putSegments' | 'listMusic' | 'listVoices' | 'getJob' | 'getDraft' | 'watchJob' | 'listJobs'
>;

export const fullDraft = (id: string, escaleta: Escaleta = draft.escaleta): Draft => ({
  id,
  sourceKind: 'url',
  sourceRef: 'https://x.test/a',
  language: 'es',
  voiceA: 'male',
  voiceB: 'female',
  mix: false,
  escaleta,
  status: 'draft',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:01Z',
});

export const fakeJob = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  draftId: 'd1',
  status: 'running',
  stage: 'images',
  progress: 0.3,
  error: null,
  outputPath: null,
  options: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:01Z',
  startedAt: null,
  finishedAt: null,
  ...over,
});

/** A fake api whose approve stream is driven by the test through `emit` / `finish` / `fail`. */
export function makeFakeApi() {
  let options: ApproveOptions | undefined;
  let resolveApprove: (e?: JobEvent) => void = () => {};
  let rejectApprove: (e: unknown) => void = () => {};
  let watchOptions: Pick<ApproveOptions, 'onEvent' | 'signal'> | undefined;
  let resolveWatch: (e?: JobEvent) => void = () => {};
  const api = {
    createDraft: vi.fn(async () => draft),
    approveDraft: vi.fn(
      (_id: string, opts: ApproveOptions) =>
        new Promise<JobEvent | undefined>((resolve, reject) => {
          options = opts;
          resolveApprove = resolve;
          rejectApprove = reject;
        }),
    ),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    getJob: vi.fn(async (id: string) => fakeJob({ id })),
    listJobs: vi.fn(async () => [] as Job[]),
    getDraft: vi.fn(async (id: string) => fullDraft(id)),
    watchJob: vi.fn(
      (_id: string, opts: Pick<ApproveOptions, 'onEvent' | 'signal'>) =>
        new Promise<JobEvent | undefined>((resolve) => {
          watchOptions = opts;
          resolveWatch = resolve;
        }),
    ),
    listMusic: vi.fn(async () => null as MusicLibrary | null),
    listVoices: vi.fn(async () => [] as VoiceOption[]),
    putSegments: vi.fn(async (id: string, escaleta: Escaleta): Promise<Draft> => fullDraft(id, escaleta)),
  } satisfies PipelineApi;
  return {
    api,
    emit: (e: Partial<JobEvent> & Pick<JobEvent, 'type'>) => options?.onEvent({ jobId: 'j1', ...e }),
    finish: (e?: JobEvent) => resolveApprove(e),
    watch: {
      emit: (e: Partial<JobEvent> & Pick<JobEvent, 'type'>) => watchOptions?.onEvent({ jobId: 'j1', ...e }),
      finish: (e?: JobEvent) => resolveWatch(e),
      get signal() {
        return watchOptions?.signal;
      },
    },
    fail: (e: unknown) => rejectApprove(e),
    get signal() {
      return options?.signal;
    },
  };
}
