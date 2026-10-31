/** Types mirroring the backend HTTP contract (backend/src/pipeline/types.ts, jobs/types.ts). */

export interface Settings {
  comfyHost: string;
  ollamaHost: string;
  piperHost: string;
  /** Ollama model used for the escaleta (empty = Ollama default). */
  ollamaModel: string;
}

export type Voice = 'male' | 'female' | string;

export type Speaker = 'A' | 'B';

export interface Scene {
  scene: number;
  title: string;
  narration: string;
  visualPrompt: string;
  voice: Voice;
  /** Presenter who delivers the line: A uses voiceA, B uses voiceB. Absent = legacy narration. */
  speaker?: Speaker;
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
  /** Approve-time options persisted by the backend (music, volume, subtitles, vertical) or null. */
  options: ApproveBody | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Non-fatal degradations recorded while the job ran (newest last, capped). Always an array. */
  warnings: string[];
}

/** Only `type` and `jobId` are guaranteed; read everything else with optional chaining. */
export interface JobEvent {
  type: 'stage' | 'progress' | 'done' | 'error' | 'cancelled';
  jobId: string;
  stage?: string;
  progress?: number;
  message?: string;
  /** Fine-grained progress inside the stage (ComfyUI sampler step). */
  substep?: { value: number; max: number };
  outputUrl?: string;
  at?: string;
}

/**
 * Body of POST /api/pipeline/draft/:id/approve. All keys optional — only send what differs
 * from the backend defaults (subtitles ON, vertical OFF, no music). The backend rejects
 * unknown keys, so keep this in sync with parseApproveOptions (backend/src/routes/pipeline.ts).
 */
export interface ApproveBody {
  /** Absolute server path of the background music file (from GET /api/music or manual). */
  music?: string;
  /** Music volume in (0, 1]; the narration ducks it via sidechain compression. */
  musicVolume?: number;
  /** Burn subtitles (ON by default). */
  subtitles?: boolean;
  /** Render vertical 9:16 (OFF by default). */
  vertical?: boolean;
}

/** One entry of GET /api/music (backend/src/lib/musicLibrary.ts). */
export interface MusicFile {
  name: string;
  path: string;
  size: number;
  mtime: string;
}

/** Response of GET /api/music. */
export interface MusicLibrary {
  musicDir: string;
  files: MusicFile[];
}

/** One entry of GET /api/pipeline/voices (Piper roster). */
export interface VoiceOption {
  name: string;
  speaker?: number;
}

/**
 * Body of POST /api/pipeline/draft. (validated by the backend, which is the authority.)
 */
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
