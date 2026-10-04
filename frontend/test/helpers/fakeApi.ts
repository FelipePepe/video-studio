import { vi } from 'vitest';
import type { ApiClient, ApproveOptions } from '../../src/api/client';
import type { DraftCreated, JobEvent } from '../../src/api/types';

export const draft: DraftCreated = {
  id: 'd1',
  status: 'draft',
  escaleta: [
    { scene: 1, title: 'Intro', narration: 'Hello', visualPrompt: 'a', voice: 'male' },
    { scene: 2, title: 'Body', narration: 'World', visualPrompt: 'b', voice: 'female' },
  ],
};

export type PipelineApi = Pick<ApiClient, 'createDraft' | 'approveDraft' | 'cancelJob'>;

/** A fake api whose approve stream is driven by the test through `emit` / `finish` / `fail`. */
export function makeFakeApi() {
  let options: ApproveOptions | undefined;
  let resolveApprove: (e?: JobEvent) => void = () => {};
  let rejectApprove: (e: unknown) => void = () => {};
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
  } satisfies PipelineApi;
  return {
    api,
    emit: (e: Partial<JobEvent> & Pick<JobEvent, 'type'>) => options?.onEvent({ jobId: 'j1', ...e }),
    finish: (e?: JobEvent) => resolveApprove(e),
    fail: (e: unknown) => rejectApprove(e),
    get signal() {
      return options?.signal;
    },
  };
}
