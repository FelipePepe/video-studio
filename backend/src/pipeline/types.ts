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
