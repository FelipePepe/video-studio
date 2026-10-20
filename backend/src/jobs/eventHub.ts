import type { JobEvent } from './types';
import { logger } from '../lib/logger';

const log = logger.child('events');

export type JobListener = (event: JobEvent) => void;

const DEFAULT_REPLAY_SIZE = 200;

export class EventHub {
  private readonly listeners = new Map<string, Set<JobListener>>();
  private readonly buffers = new Map<string, JobEvent[]>();

  constructor(private readonly replaySize: number = DEFAULT_REPLAY_SIZE) {}

  subscribe(jobId: string, listener: JobListener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) this.listeners.set(jobId, (set = new Set()));
    set.add(listener);
    return () => {
      const current = this.listeners.get(jobId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(jobId);
    };
  }

  publish(event: JobEvent): void {
    const buffer = this.buffers.get(event.jobId) ?? [];
    buffer.push(event);
    if (buffer.length > this.replaySize) buffer.splice(0, buffer.length - this.replaySize);
    this.buffers.set(event.jobId, buffer);
    for (const listener of [...(this.listeners.get(event.jobId) ?? [])]) {
      try {
        listener(event);
      } catch (e) {
        log.error('event listener failed', { jobId: event.jobId, err: e });
      }
    }
  }

  replay(jobId: string): JobEvent[] {
    return [...(this.buffers.get(jobId) ?? [])];
  }

  listenerCount(jobId: string): number {
    return this.listeners.get(jobId)?.size ?? 0;
  }

  clear(jobId: string): void {
    this.buffers.delete(jobId);
    this.listeners.delete(jobId);
  }
}
