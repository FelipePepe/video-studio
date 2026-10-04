/** Types mirroring the backend HTTP contract (backend/src/pipeline/types.ts, jobs/types.ts). */

export interface Settings {
  comfyHost: string;
  ollamaHost: string;
  piperHost: string;
}

export type Voice = 'male' | 'female' | string;

export interface Scene {
  scene: number;
  title: string;
  narration: string;
  visualPrompt: string;
  voice: Voice;
}

export type Escaleta = Scene[];

export interface Draft {
  id: string;
  sourceKind: 'url' | 'text';
  sourceRef: string;
  language: string;
  voiceA: Voice;
  voiceB: Voice;
  mix: boolean;
  escaleta: Escaleta;
  status: 'draft' | 'approved';
  createdAt: string;
  updatedAt: string;
}

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

/** Only `type` and `jobId` are guaranteed; read everything else with optional chaining. */
export interface JobEvent {
  type: 'stage' | 'progress' | 'done' | 'error' | 'cancelled';
  jobId: string;
  stage?: string;
  progress?: number;
  message?: string;
  outputUrl?: string;
  at?: string;
}

/** Body of POST /api/pipeline/draft (validated by the backend, which is the authority). */
export interface DraftRequest {
  url?: string;
  text?: string;
  language?: string;
  voiceA?: Voice;
  voiceB?: Voice;
  mix?: boolean;
}

/** Response of POST /api/pipeline/draft. */
export interface DraftCreated {
  id: string;
  escaleta: Escaleta;
  status: Draft['status'];
}
