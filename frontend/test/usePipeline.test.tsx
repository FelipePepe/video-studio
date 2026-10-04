import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { usePipeline } from '../src/hooks/usePipeline';
import { draft, makeFakeApi } from './helpers/fakeApi';

async function toReview(fake = makeFakeApi()) {
  const hook = renderHook(() => usePipeline(fake.api));
  await act(async () => {
    await hook.result.current.createDraft({ url: 'https://x.test/a' });
  });
  return { fake, hook };
}

async function toRendering() {
  const ctx = await toReview();
  act(() => {
    void ctx.hook.result.current.approve();
  });
  return ctx;
}

const stageStates = (r: { current: ReturnType<typeof usePipeline> }) => r.current.stages.map((s) => s.status);

describe('usePipeline', () => {
  it('starts idle with four pending stages', () => {
    const { result } = renderHook(() => usePipeline(makeFakeApi().api));
    expect(result.current.state).toBe('idle');
    expect(result.current.draft).toBeNull();
    expect(result.current.stages.map((s) => s.id)).toEqual(['tts', 'images', 'transitions', 'assemble']);
    expect(stageStates(result)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('goes idle -> drafting -> review on createDraft', async () => {
    const fake = makeFakeApi();
    let release: (d: typeof draft) => void = () => {};
    fake.api.createDraft.mockImplementation(() => new Promise((r) => (release = r)));
    const { result } = renderHook(() => usePipeline(fake.api));
    act(() => {
      void result.current.createDraft({ text: 'hi' });
    });
    expect(result.current.state).toBe('drafting');
    await act(async () => release(draft));
    expect(result.current.state).toBe('review');
    expect(result.current.draft).toEqual(draft);
    expect(fake.api.createDraft).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('maps ApiError and network errors to a readable error and returns to idle', async () => {
    const fake = makeFakeApi();
    const { result } = renderHook(() => usePipeline(fake.api));
    fake.api.createDraft.mockRejectedValueOnce(new ApiError(502, 'Ollama is down'));
    await act(async () => {
      await result.current.createDraft({ url: 'u' });
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('Ollama is down');

    fake.api.createDraft.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => {
      await result.current.createDraft({ url: 'u' });
    });
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toBe('Ollama is down');

    await act(async () => {
      await result.current.createDraft({ url: 'u' });
    });
    expect(result.current.error).toBeNull();
    expect(result.current.state).toBe('review');
  });

  it('opens the approve stream with the draft id and a signal -> rendering', async () => {
    const { fake, hook } = await toRendering();
    expect(hook.result.current.state).toBe('rendering');
    expect(fake.api.approveDraft).toHaveBeenCalledWith('d1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('advances stages, captures jobId and keeps progress monotonic', async () => {
    const { fake, hook } = await toRendering();
    const r = hook.result;
    act(() => fake.emit({ type: 'stage', stage: 'queued', progress: 0 }));
    expect(r.current.jobId).toBe('j1');
    expect(stageStates(r)).toEqual(['pending', 'pending', 'pending', 'pending']);
    act(() => fake.emit({ type: 'stage', stage: 'tts', progress: 0.1 }));
    expect(stageStates(r)).toEqual(['active', 'pending', 'pending', 'pending']);
    act(() => fake.emit({ type: 'progress', stage: 'images', progress: 0.5 }));
    expect(stageStates(r)).toEqual(['done', 'active', 'pending', 'pending']);
    expect(r.current.progress).toBe(0.5);
    act(() => fake.emit({ type: 'progress', stage: 'images', progress: 0.3 }));
    expect(r.current.progress).toBe(0.5);
    act(() => fake.emit({ type: 'stage', stage: 'assemble', progress: 0.9 }));
    expect(stageStates(r)).toEqual(['done', 'done', 'done', 'active']);
  });

  it('collects transition fallback messages as warnings', async () => {
    const { fake, hook } = await toRendering();
    act(() => fake.emit({ type: 'progress', stage: 'transitions', progress: 0.6, message: 'Scene 2: hard cut' }));
    act(() => fake.emit({ type: 'progress', stage: 'transitions', progress: 0.7, message: 'Scene 2: hard cut' }));
    expect(hook.result.current.warnings).toEqual(['Scene 2: hard cut']);
  });

  it('finishes with the event outputUrl or falls back to /api/jobs/:id/output', async () => {
    const a = await toRendering();
    act(() => a.fake.emit({ type: 'done', outputUrl: '/api/jobs/j1/output?x=1' }));
    expect(a.hook.result.current.state).toBe('done');
    expect(a.hook.result.current.outputUrl).toBe('/api/jobs/j1/output?x=1');
    expect(a.hook.result.current.progress).toBe(1);
    expect(stageStates(a.hook.result)).toEqual(['done', 'done', 'done', 'done']);

    const b = await toRendering();
    act(() => b.fake.emit({ type: 'done' }));
    expect(b.hook.result.current.outputUrl).toBe('/api/jobs/j1/output');
  });

  it('fails on error and cancelled events marking the active stage as failed', async () => {
    const a = await toRendering();
    act(() => a.fake.emit({ type: 'stage', stage: 'images', progress: 0.3 }));
    act(() => a.fake.emit({ type: 'error', message: 'ComfyUI exploded' }));
    expect(a.hook.result.current.state).toBe('failed');
    expect(a.hook.result.current.error).toBe('ComfyUI exploded');
    expect(stageStates(a.hook.result)).toEqual(['done', 'failed', 'pending', 'pending']);

    const b = await toRendering();
    act(() => b.fake.emit({ type: 'cancelled' }));
    expect(b.hook.result.current.state).toBe('failed');
    expect(b.hook.result.current.error).toBeTruthy();
  });

  it('shows a clear error when approve rejects with 409', async () => {
    const { fake, hook } = await toRendering();
    await act(async () => fake.fail(new ApiError(409, 'Draft is already approved')));
    expect(hook.result.current.state).toBe('failed');
    expect(hook.result.current.error).toMatch(/aprobad|approved|en curso|progress/i);
  });

  it('fails when the stream ends without a terminal event', async () => {
    const { fake, hook } = await toRendering();
    await act(async () => fake.finish(undefined));
    expect(hook.result.current.state).toBe('failed');
  });

  it('cancel calls api.cancelJob with the captured job id', async () => {
    const { fake, hook } = await toRendering();
    act(() => fake.emit({ type: 'stage', stage: 'tts', progress: 0.1 }));
    await act(async () => {
      await hook.result.current.cancel();
    });
    expect(fake.api.cancelJob).toHaveBeenCalledWith('j1');
  });

  it('can approve again after a failure, resetting progress and stages', async () => {
    const { fake, hook } = await toRendering();
    act(() => fake.emit({ type: 'progress', stage: 'images', progress: 0.5 }));
    act(() => fake.emit({ type: 'error', message: 'boom' }));
    expect(hook.result.current.state).toBe('failed');
    act(() => {
      void hook.result.current.approve();
    });
    expect(hook.result.current.state).toBe('rendering');
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.progress).toBe(0);
    expect(stageStates(hook.result)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(fake.api.approveDraft).toHaveBeenCalledTimes(2);
  });

  it('reset returns to idle and clears the draft', async () => {
    const { hook } = await toReview();
    act(() => hook.result.current.reset());
    expect(hook.result.current.state).toBe('idle');
    expect(hook.result.current.draft).toBeNull();
  });

  it('unmounting aborts the listener without cancelling the job or updating state', async () => {
    const { fake, hook } = await toRendering();
    const signal = fake.signal!;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    expect(fake.api.cancelJob).not.toHaveBeenCalled();
    const errors: unknown[] = [];
    const spy = (...a: unknown[]) => errors.push(a);
    const orig = console.error;
    console.error = spy;
    try {
      await act(async () => {
        fake.emit({ type: 'progress', progress: 0.5 });
        fake.fail(new Error('aborted'));
      });
      await waitFor(() => expect(errors).toEqual([]));
    } finally {
      console.error = orig;
    }
  });
});
