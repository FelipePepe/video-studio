export type Connection = [string, number];
export type NodeInput = string | number | boolean | Connection;

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, NodeInput>;
  _meta?: { title: string };
}

export type Workflow = Record<string, WorkflowNode>;

export const WAN_VAE = 'wan_2.1_vae.safetensors';
export const T2V_MODEL = 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors';
export const T2V_LOW_MODEL = 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors';
export const I2V_MODEL = 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors';
export const I2V_LOW_MODEL = 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors';
export const T5_ENCODER = 'umt5-xxl-enc-fp8_e4m3fn-fixed.safetensors';

// lightx2v 4-step LoRAs (high/low) — dramatically reduce denoising steps while keeping quality.
// doc §1: 10× faster renders with near-identical output.
export const LORA = {
  t2v_high: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors',
  t2v_low: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors',
  i2v_high: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
  i2v_low: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors',
} as const;

export const DEFAULTS = {
  width: 1280,
  height: 720,
  numFrames: 81,
  steps: 50,
  // Step at which control passes from the high-noise expert to the low-noise expert, out of
  // `steps` total. Wan 2.2 is a MoE: the high-noise expert settles structure/motion in the first
  // steps, the low-noise expert refines detail in the last. 42/50 ≈ 84 % high / 16 % low.
  switchStep: 42,
  cfg: 6.0,
  shift: 5.0,
  scheduler: 'unipc',
  blockSwap: 20,
  fps: 16,
} as const;

const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, watermark, text, static, deformed';

interface CommonOptions {
  prompt: string;
  negativePrompt?: string;
  seed: number;
  width?: number;
  height?: number;
  numFrames?: number;
  steps?: number;
  switchStep?: number;
  filenamePrefix?: string;
  pingpong?: boolean;
  /** doc §1: attach the lightx2v 4-step LoRA (high/low) to the dual-expert and drop to 4 total steps. ~10× faster, same quality. */
  useLightx2v?: boolean;
}

export type T2VOptions = CommonOptions;

export interface I2VOptions extends CommonOptions {
  startImage: string;
  endImage?: string;
}

class Builder {
  readonly nodes: Workflow = {};
  private next = 1;

  add(class_type: string, inputs: Record<string, NodeInput>): string {
    const id = String(this.next++);
    this.nodes[id] = { class_type, inputs };
    return id;
  }
}

interface SharedNodes {
  text: string;
  vae: string;
}

/** Text embedding and VAE are identical for both experts, so they are built once and shared. */
function buildShared(o: CommonOptions, b: Builder): SharedNodes {
  const t5 = b.add('LoadWanVideoT5TextEncoder', {
    model_name: T5_ENCODER,
    precision: 'fp32',
    load_device: 'offload_device',
  });
  const text = b.add('WanVideoTextEncode', {
    positive_prompt: o.prompt,
    negative_prompt: o.negativePrompt ?? DEFAULT_NEGATIVE,
    t5: [t5, 0],
    force_offload: true,
  });
  const vae = b.add('WanVideoVAELoader', { model_name: WAN_VAE, precision: 'bf16' });
  return { text, vae };
}

interface ModelChain {
  loader: string;
  setSwap: string;
  loras: string;
}

/** Per-expert chain: model loader -> block swap config -> set block swap -> set LoRAs. */
function buildModelChain(model: string, b: Builder, loraName?: string): ModelChain {
  const loader = b.add('WanVideoModelLoader', {
    model,
    base_precision: 'fp16_fast',
    quantization: 'fp8_e4m3fn_scaled',
    load_device: 'offload_device',
  });
  const swapArgs = b.add('WanVideoBlockSwap', {
    blocks_to_swap: DEFAULTS.blockSwap,
    offload_img_emb: false,
    offload_txt_emb: false,
  });
  const setSwap = b.add('WanVideoSetBlockSwap', { model: [loader, 0], block_swap_args: [swapArgs, 0] });
  const setLoras = b.add('WanVideoSetLoRAs', { model: [setSwap, 0] });
  if (loraName) {
    // fp8_scaled models can't bake LoRAs in, so load them on the fly (merge_loras off).
    const lora = b.add('WanVideoLoraSelect', { lora: loraName, strength: 1.0, merge_loras: false });
    // Re-point the SetLoRAs node to include the LoRA.
    b.nodes[setLoras].inputs.lora = [lora, 0];
  }
  return { loader, setSwap, loras: setLoras };
}

function buildTail(
  b: Builder,
  o: CommonOptions,
  shared: SharedNodes,
  high: ModelChain,
  low: ModelChain,
  embeds: string,
): Workflow {
  const steps = o.steps ?? DEFAULTS.steps;
  const switchStep = o.switchStep ?? DEFAULTS.switchStep;
  const samplerInputs = (model: string): Record<string, NodeInput> => ({
    model: [model, 0],
    image_embeds: [embeds, 0],
    text_embeds: [shared.text, 0],
    steps,
    cfg: DEFAULTS.cfg,
    shift: DEFAULTS.shift,
    seed: o.seed,
    force_offload: true,
    scheduler: DEFAULTS.scheduler,
    riflex_freq_index: 0,
  });
  // Expert 1 (high noise) opens the step range from pure noise and emits a part-denoised latent.
  const sampler1 = b.add('WanVideoSampler', { ...samplerInputs(high.loras), start_step: 0, end_step: switchStep });
  // Expert 2 (low noise) continues from that latent for the remaining steps; no re-noising.
  const sampler2 = b.add('WanVideoSampler', {
    ...samplerInputs(low.loras),
    samples: [sampler1, 0],
    start_step: switchStep,
    end_step: -1,
  });
  const decode = b.add('WanVideoDecode', {
    vae: [shared.vae, 0],
    samples: [sampler2, 0],
    enable_vae_tiling: false,
    tile_x: 272,
    tile_y: 272,
    tile_stride_x: 144,
    tile_stride_y: 144,
  });
  b.add('VHS_VideoCombine', {
    images: [decode, 0],
    frame_rate: DEFAULTS.fps,
    loop_count: 0,
    filename_prefix: o.filenamePrefix ?? 'video_studio',
    format: 'video/h264-mp4',
    pix_fmt: 'yuv420p',
    crf: 19,
    save_metadata: false,
    trim_to_audio: false,
    pingpong: o.pingpong ?? true,
    save_output: true,
  });
  return b.nodes;
}

export function buildT2VWorkflow(o: T2VOptions): Workflow {
  const b = new Builder();
  const shared = buildShared(o, b);
  const high = buildModelChain(T2V_MODEL, b, o.useLightx2v ? LORA.t2v_high : undefined);
  const low = buildModelChain(T2V_LOW_MODEL, b, o.useLightx2v ? LORA.t2v_low : undefined);
  const embeds = b.add('WanVideoEmptyEmbeds', {
    width: o.width ?? DEFAULTS.width,
    height: o.height ?? DEFAULTS.height,
    num_frames: o.numFrames ?? DEFAULTS.numFrames,
  });
  return buildTail(b, withLightx2v(o), shared, high, low, embeds);
}

// lightx2v: 4 total steps split 3 (high) / 1 (low) across the dual expert.
function withLightx2v(o: CommonOptions): CommonOptions {
  if (!o.useLightx2v) return o;
  return { ...o, steps: o.steps ?? 4, switchStep: o.switchStep ?? 3 };
}

export function buildI2VWorkflow(o: I2VOptions): Workflow {
  const b = new Builder();
  const shared = buildShared(o, b);
  const high = buildModelChain(I2V_MODEL, b, o.useLightx2v ? LORA.i2v_high : undefined);
  const low = buildModelChain(I2V_LOW_MODEL, b, o.useLightx2v ? LORA.i2v_low : undefined);
  const width = o.width ?? DEFAULTS.width;
  const height = o.height ?? DEFAULTS.height;

  const resized = (image: string): string => {
    const load = b.add('LoadImage', { image });
    return b.add('WanVideoImageResizeToClosest', {
      image: [load, 0],
      generation_width: width,
      generation_height: height,
      aspect_ratio_preservation: 'keep_input',
    });
  };

  const start = resized(o.startImage);
  const end = o.endImage ? resized(o.endImage) : undefined;
  const encodeInputs: Record<string, NodeInput> = {
    width,
    height,
    num_frames: o.numFrames ?? DEFAULTS.numFrames,
    noise_aug_strength: 0.0,
    start_latent_strength: 1.0,
    end_latent_strength: 1.0,
    force_offload: true,
    vae: [shared.vae, 0],
    start_image: [start, 0],
  };
  if (end) encodeInputs.end_image = [end, 0];
  const embeds = b.add('WanVideoImageToVideoEncode', encodeInputs);
  return buildTail(b, withLightx2v(o), shared, high, low, embeds);
}
