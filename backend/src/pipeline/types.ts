export type Voice = 'male' | 'female' | string;

/** Options the approve endpoint accepts (E1: BGM, E2: subtitles). Stored as JSON on the job row. */
export interface ApproveOptions {
  /** Absolute path of a BGM file readable by the server. */
  music?: string;
  /** BGM target volume, 0.01..1 (default 0.25). */
  musicVolume?: number;
  /** Burn the escaleta subtitles into the final video. Default true. */
  subtitles?: boolean;
}

export const DEFAULT_MUSIC_VOLUME = 0.25;

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
