import type { ComfyClient } from '../clients/comfy';

export class PipelineAgentError extends Error {}

export type AgentMode = 't2v' | 'i2v';

const MODES: readonly AgentMode[] = ['t2v', 'i2v'];

export interface PipelineAgentRequest {
  visualPrompt: string;
  negativePrompt?: string;
  seed: number;
  /** ComfyUI `LoadImage` filename. Presence implies i2v intent. */
  startImage?: string;
  /** ComfyUI `LoadImage` filename. Omitted → the `end_image` key must be left out. */
  endImage?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  filenamePrefix?: string;
}

export interface PipelineAgentResult {
  promptId: string;
  mode: AgentMode;
}

export interface PipelineAgentOptions {
  /** Ollama base URL, e.g. http://192.168.1.60:11434 */
  host: string;
  model?: string;
  fetchImpl?: typeof fetch;
  comfy: ComfyClient;
}

const SYSTEM_PROMPT = `You build exact ComfyUI API-format workflows for Wan2.2 video generation with WanVideoWrapper nodes.
A ComfyUI API workflow is a JSON object mapping node id strings to { class_type, inputs }; connections are [nodeId, slot] pairs.

Fixed nodes and wiring (never deviate):
- LoadWanVideoT5TextEncoder with model_name umt5-xxl-enc-fp8_e4m3fn-fixed.safetensors, precision fp32, load_device offload_device.
- WanVideoTextEncode with positive_prompt, negative_prompt, t5 connection, force_offload true.
- TWO WanVideoModelLoaders with base_precision fp16_fast, quantization fp8_e4m3fn_scaled, load_device offload_device, one per expert (Wan2.2 is MoE: high-noise expert on the opening steps, low-noise on the last steps):
  - T2V mode: wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors and wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors.
  - I2V mode: wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors and wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors.
- Each loader has its own WanVideoBlockSwap (blocks_to_swap 20, offload_img_emb false, offload_txt_emb false) → WanVideoSetBlockSwap → WanVideoSetLoRAs chain (no LoRAs; the node is mandatory by the chain).
- WanVideoVAELoader with model_name wan_2.1_vae.safetensors and precision bf16. This VAE choice is fixed and must NEVER be changed.
- T2V: WanVideoEmptyEmbeds with width/height/num_frames.
- I2V: LoadImage + WanVideoImageResizeToClosest (aspect_ratio_preservation keep_input) for start and end images, then WanVideoImageToVideoEncode with noise_aug_strength 0.0, start_latent_strength 1.0, end_latent_strength 1.0, force_offload true, vae from WanVideoVAELoader. When no end image is given, OMIT the end_image key entirely — never send a null or empty value.
- TWO WanVideoSamplers split the denoising by step. Both share the same text_embeds, image_embeds, steps 50, cfg 6.0, shift 5.0, scheduler unipc, force_offload true, riflex_freq_index 0, and the request seed:
  - s1 (high-noise): model = the high-noise WanVideoSetLoRAs output; start_step = 0; end_step = switchStep (default 42); no samples input.
  - s2 (low-noise): model = the low-noise WanVideoSetLoRAs output; samples = [s1, 0] (continues from the s1 latent); start_step = switchStep; end_step = -1.
- WanVideoDecode takes samples from the low-noise sampler (s2): enable_vae_tiling false, tile_x 272, tile_y 272, tile_stride_x 144, tile_stride_y 144.
- VHS_VideoCombine: frame_rate 16, loop_count 0, format video/h264-mp4, pix_fmt yuv420p, crf 19, save_metadata false, save_output true.

Defaults when the request does not specify them: width 1280, height 720, num_frames 81 (~5 s at 16 fps).

Call the submit_workflow tool exactly once with the complete workflow JSON and the mode used.
Do not emit any other tools, do not ask questions, do not add commentary.`;

function systemUserMessage(req: PipelineAgentRequest): string {
  return (
    'Generate the Wan2.2 workflow for this scene and submit it with submit_workflow.\n' +
    JSON.stringify(req, null, 2)
  );
}

function toolDefinition(): object {
  return {
    type: 'function',
    function: {
      name: 'submit_workflow',
      description: 'Submit the final ComfyUI API-format workflow for Wan2.2 video generation.',
      parameters: {
        type: 'object',
        properties: {
          workflow: {
            type: 'object',
            description: 'Complete ComfyUI API workflow: node id -> { class_type, inputs }',
          },
          mode: { type: 'string', enum: [...MODES] },
        },
        required: ['workflow', 'mode'],
        additionalProperties: false,
      },
    },
  };
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // fall through to the invalid error
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  throw new PipelineAgentError('submit_workflow arguments must be a JSON object');
}

export class PipelineAgent {
  private readonly host: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly comfy: ComfyClient;

  constructor(opts: PipelineAgentOptions) {
    this.host = opts.host.replace(/\/+$/, '');
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? 'gemma4:26b';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.comfy = opts.comfy;
  }

  /** Runs the agentic loop against Ollama tool-calling and stops at the first submit_workflow call. */
  async generate(req: PipelineAgentRequest): Promise<PipelineAgentResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          tools: [toolDefinition()],
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: systemUserMessage(req) },
          ],
        }),
      });
    } catch (e) {
      throw new Error(`Ollama unreachable at ${this.host}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PipelineAgentError(`Ollama /api/chat failed: ${res.status}${body ? ` ${body}` : ''}`);
    }
    const data = (await res.json()) as {
      message?: {
        tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
      };
    };
    const call = data.message?.tool_calls?.find((t) => t.function?.name === 'submit_workflow');
    if (!call?.function) {
      throw new PipelineAgentError('Ollama response has no submit_workflow tool call');
    }
    const args = parseArgs(call.function.arguments);
    const mode = args.mode;
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
      throw new PipelineAgentError(`submit_workflow mode must be one of ${MODES.join(', ')}`);
    }
    const workflow = args.workflow;
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || Object.keys(workflow).length === 0) {
      throw new PipelineAgentError('submit_workflow workflow must be a non-empty object');
    }
    const promptId = await this.comfy.submit(workflow as object);
    return { promptId, mode: mode as AgentMode };
  }
}
