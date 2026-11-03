import { extractOutputFile, type ComfyClient } from '../clients/comfy';
import { buildQwenImageWorkflow } from '../comfy/workflows';

export interface CharacterGenInput {
  prompt: string;
  negativePrompt: string;
  seed: number;
  signal?: AbortSignal;
}

/** Returns the bytes of ONE PNG. */
export type CharacterGenerator = (input: CharacterGenInput) => Promise<Buffer>;

const NEGATIVE =
  'blurry, low quality, deformed, text, watermark, extra characters, green clothing, green sweater, green shirt, green clothes, green hair, green skin, shadows on the background, gradient background, backdrop gradient, floor, table, horizon line, full body, hands';

export function buildCharacterPrompt(description: string): { prompt: string; negativePrompt: string } {
  return {
    prompt: `${description.trim()}. The character wears a plain knitted sweater in a warm or neutral colour (purple, mustard yellow or maroon) and has no green anywhere on the character, only the background is green. Head and shoulders, front view facing the camera, gentle closed-mouth smile with red felt lips, wool felt fabric texture with visible stitching, crisp sharp focus. Perfectly uniform flat pure bright green (#00FF00) backdrop filling the whole frame, evenly lit, no gradient, no vignette, no floor line, no shadows, no floor`,
    negativePrompt: NEGATIVE,
  };
}

export function comfyCharacterGenerator(resolveComfy: () => ComfyClient): CharacterGenerator {
  return async ({ prompt, negativePrompt, seed, signal }) => {
    const comfy = resolveComfy();
    const id = await comfy.submit(
      buildQwenImageWorkflow({ prompt, negativePrompt, seed, filenamePrefix: 'character' }),
    );
    const outputs = await comfy.waitForCompletion(id, { signal });
    const file = extractOutputFile(outputs);
    if (!file) throw new Error('ComfyUI returned no image output');
    return Buffer.from(await comfy.download(file));
  };
}
