import type { ApproveOptions } from '../pipeline/types';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  draftId: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  outputPath: string | null;
  /** Approve-time options (JSON), or null. */
  options: ApproveOptions | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Non-fatal degradations recorded while the job ran (newest last, capped). Always an array. */
  warnings: string[];
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
  /** The `message` is a non-fatal degradation: the runner persists it on the job. */
  warning?: boolean;
  /** Fine-grained progress inside the current stage (e.g. ComfyUI sampler step value/max). */
  substep?: { value: number; max: number };
  outputUrl?: string;
  at: string;
}

export type EmitInput = Omit<JobEvent, 'jobId' | 'at'>;

export interface JobContext {
  signal: AbortSignal;
  workDir: string;
  emit(partial: EmitInput): void;
}
/**
 * The pipeline result. `outputPath` is guaranteed; the chapter fields are
 * present when the assembler produced a deliverable (kept structurally
 * generic here to avoid a circular import of the pipeline's `Chapter`).
 */
export interface ExecuteResult {
  outputPath: string;
  /** Absolute path to `chapters.json` (chapter markers aligned to the timeline). */
  chaptersPath?: string;
  /** Chapter markers (index, title, startSec, durationSec). */
  chapters?: Array<{ index: number; title: string; startSec: number; durationSec: number }>;
}

export type ExecuteFn = (job: Job, ctx: JobContext) => Promise<ExecuteResult>;

export const TERMINAL_EVENT_TYPES: ReadonlySet<JobEvent['type']> = new Set(['done', 'error', 'cancelled']);
