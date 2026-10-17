export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  draftId: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  outputPath: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Only `type` and `jobId` are guaranteed. Every other field depends on the event
 * type, so consumers must read them with optional chaining.
 */
export interface JobEvent {
  type: 'stage' | 'progress' | 'done' | 'error' | 'cancelled';
  jobId: string;
  stage?: string;
  progress?: number;
  message?: string;
  outputUrl?: string;
  at: string;
}

export type EmitInput = Omit<JobEvent, 'jobId' | 'at'>;

export interface JobContext {
  signal: AbortSignal;
  workDir: string;
  emit(partial: EmitInput): void;
}

export type ExecuteFn = (job: Job, ctx: JobContext) => Promise<{ outputPath: string }>;

export const TERMINAL_EVENT_TYPES: ReadonlySet<JobEvent['type']> = new Set(['done', 'error', 'cancelled']);
