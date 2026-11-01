import { extractOutputFile, type ComfyClient } from '../clients/comfy';
import { buildT2VWorkflow } from '../comfy/workflows';

export interface CharacterGenInput {
  prompt: string;
  negativePrompt: string;
  seed: number;
  signal?: AbortSignal;
}

/** Returns the bytes of ONE PNG. */
export type CharacterGenerator = (input: CharacterGenInput) => Promise<Buffer>;

const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, watermark, text, static, deformed';

export function buildCharacterPrompt(description: string): { prompt: string; negativePrompt: string } {
  return {
    prompt: `${description.trim()}. Original hand-made felt puppet character, front view, upper body, facing the camera, mouth closed, soft felt texture, studio lighting, centred, on a flat solid uniform bright green background, nothing else in the frame, no text`,
    negativePrompt: `${DEFAULT_NEGATIVE}, green clothing, green fur, green skin, shadows on the background, gradient background, multiple characters, text, watermark`,
  };
}

export function comfyCharacterGenerator(resolveComfy: () => ComfyClient): CharacterGenerator {
  return async ({ prompt, negativePrompt, seed, signal }) => {
    const comfy = resolveComfy();
    const id = await comfy.submit(
      buildT2VWorkflow({
        prompt,
        negativePrompt,
        seed,
        numFrames: 1,
        pingpong: false,
        saveImage: true,
        useLightx2v: true,
        width: 1024,
        height: 1024,
        filenamePrefix: 'character',
      }),
    );
    const outputs = await comfy.waitForCompletion(id, { signal });
    const file = extractOutputFile(outputs);
    if (!file) throw new Error('ComfyUI returned no image output');
    return Buffer.from(await comfy.download(file));
  };
}
