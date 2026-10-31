export type Voice = 'male' | 'female' | string;

/** Options the approve endpoint accepts (E1: BGM, E2: subtitles). Stored as JSON on the job row. */
export interface ApproveOptions {
  /** Absolute path of a BGM file readable by the server. */
  music?: string;
  /** BGM target volume, 0.01..1 (default 0.25). */
  musicVolume?: number;
  /** Burn the escaleta subtitles into the final video. Default true. */
  subtitles?: boolean;
  /** Also produce a 9:16 vertical crop (`final_v.mp4`). Default false. */
  vertical?: boolean;
  /**
   * Global visual style (lighting / palette / realism) applied to **every** scene's visual prompt
   * for consistency across the video. doc §1 — cheaper than training a LoRA per video.
   */
  style?: string;
  /**
   * doc §1 — attach the lightx2v 4-step LoRA (high + low) to both experts of the dual-expert pipeline.
   * Cuts the denoise from 50 to 4 steps (~10× faster, same quality). Default false.
   */
  useLightx2v?: boolean;
}

export const DEFAULT_MUSIC_VOLUME = 0.25;

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
