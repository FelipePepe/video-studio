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
export const I2V_MODEL = 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors';
export const T5_ENCODER = 'umt5-xxl-enc-fp8_e4m3fn-fixed.safetensors';

export const DEFAULTS = {
  width: 1280,
  height: 720,
  numFrames: 81,
  steps: 50,
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
  filenamePrefix?: string;
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

function buildBase(model: string, o: CommonOptions, b: Builder) {
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
  // No LoRAs are applied, but the Atlas note's chain makes this node mandatory (the sampler takes its output).
  const loras = b.add('WanVideoSetLoRAs', { model: [setSwap, 0] });
  const vae = b.add('WanVideoVAELoader', { model_name: WAN_VAE, precision: 'bf16' });
  return { text, loras, vae };
}

function buildTail(
  b: Builder,
  o: CommonOptions,
  base: { text: string; loras: string; vae: string },
  embeds: string,
): Workflow {
  const sampler = b.add('WanVideoSampler', {
    model: [base.loras, 0],
    image_embeds: [embeds, 0],
    text_embeds: [base.text, 0],
    steps: o.steps ?? DEFAULTS.steps,
    cfg: DEFAULTS.cfg,
    shift: DEFAULTS.shift,
    seed: o.seed,
    force_offload: true,
    scheduler: DEFAULTS.scheduler,
    riflex_freq_index: 0,
  });
  const decode = b.add('WanVideoDecode', {
    vae: [base.vae, 0],
    samples: [sampler, 0],
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
    // Required by the Atlas note's VHS_VideoCombine settings (clip plays forward then back).
    pingpong: true,
    save_output: true,
  });
  return b.nodes;
}

export function buildT2VWorkflow(o: T2VOptions): Workflow {
  const b = new Builder();
  const base = buildBase(T2V_MODEL, o, b);
  const embeds = b.add('WanVideoEmptyEmbeds', {
    width: o.width ?? DEFAULTS.width,
    height: o.height ?? DEFAULTS.height,
    num_frames: o.numFrames ?? DEFAULTS.numFrames,
  });
  return buildTail(b, o, base, embeds);
}

export function buildI2VWorkflow(o: I2VOptions): Workflow {
  const b = new Builder();
  const base = buildBase(I2V_MODEL, o, b);
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
    vae: [base.vae, 0],
    start_image: [start, 0],
  };
  if (end) encodeInputs.end_image = [end, 0];
  const embeds = b.add('WanVideoImageToVideoEncode', encodeInputs);
  return buildTail(b, o, base, embeds);
}
