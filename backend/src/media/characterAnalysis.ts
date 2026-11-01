import { spawn } from 'node:child_process';
import zlib from 'node:zlib';

export interface CharacterAnalysis {
  keyColor: string; // '0xRRGGBB' sampled at (margin, margin) of the image
  width: number;
  height: number;
  crop: { x: number; y: number; w: number; h: number }; // bbox of the non-background area, padded
  mouth: MouthBox | null; // largest deep-red blob (full-image pixels); null when not found or no runFfmpegRaw
}

/** Box in FULL-image pixels. */
export interface MouthBox { x: number; y: number; w: number; h: number }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Header { width: number; height: number; bitDepth: number; colorType: number; interlace: number }

function parseHeader(png: Buffer): Header {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file');
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
    interlace: png[28],
  };
}

export function pngSize(png: Buffer): { width: number; height: number } {
  const { width, height } = parseHeader(png);
  return { width, height };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reads one pixel of an 8-bit non-interlaced RGB or RGBA PNG (colour type 2 or 6) using only node:zlib. */
export function readPngPixel(png: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  const { width, height, bitDepth, colorType, interlace } = parseHeader(png);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(`pixel (${x},${y}) is out of range for a ${width}x${height} image`);
  }

  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const data = zlib.inflateSync(Buffer.concat(idat));

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const start = row * (stride + 1);
    const filter = data[start];
    for (let i = 0; i < stride; i++) {
      const v = data[start + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add: number;
      switch (filter) {
        case 0: add = 0; break;
        case 1: add = a; break;
        case 2: add = b; break;
        case 3: add = (a + b) >> 1; break;
        case 4: add = paeth(a, b, c); break;
        default: throw new Error(`invalid PNG filter type ${filter}`);
      }
      cur[i] = (v + add) & 0xff;
    }
    if (row < y) [prev, cur] = [cur, prev];
  }
  const o = x * bpp;
  return { r: cur[o], g: cur[o + 1], b: cur[o + 2] };
}

export interface AnalyzeDeps {
  /** Runs ffmpeg with these args and resolves with its STDERR text (cropdetect prints there). */
  runFfmpegCapture: (args: string[]) => Promise<string>;
  /** Runs ffmpeg with these args and resolves with its STDOUT bytes. Optional: without it, mouth detection is skipped. */
  runFfmpegRaw?: (args: string[]) => Promise<Buffer>;
}

export const runFfmpegRaw: NonNullable<AnalyzeDeps['runFfmpegRaw']> = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });

const MASK_MAX_SIDE = 256;
const MIN_BLOB_RATIO = 0.002; // blob must cover >= 0.2 % of the mask (a thin smile is only a few px tall)
const WIDE_RATIO = 1.8; // w/h from which a blob counts as a mouth shape (a nose is round)
const MIN_BOX_ASPECT = 0.4; // thin boxes are grown to h = 0.4 w
const MOUTH_PAD_RATIO = 0.03;

function maskSize(width: number, height: number): { mw: number; mh: number } {
  const s = Math.min(1, MASK_MAX_SIDE / Math.max(width, height));
  return { mw: Math.max(1, Math.round(width * s)), mh: Math.max(1, Math.round(height * s)) };
}

/**
 * ffmpeg args producing a raw gray mask (mw*mh bytes) of "deep red" pixels: 255 where the pixel is bright red (r>140, g<70, b<90) or dark maroon (r>80, g<50, b<60, r>2g).
 * The image is area-downscaled first (longest side <= 256), then geq (on gbrp planes) writes the same
 * 0/255 value into r, g and b so format=gray yields the mask.
 */
export function mouthMaskArgs(imagePath: string, width: number, height: number): string[] {
  const { mw, mh } = maskSize(width, height);
  // bright red lips OR dark maroon (the shaded inside of an open mouth, which fails the bright test)
  // both clauses also require b >= 0.8 g: lips are crimson, orange hair (b < g) must not match
  const crimson = `gte(b(X,Y),0.8*g(X,Y))`;
  const bright = `gt(r(X,Y),140)*lt(g(X,Y),70)*lt(b(X,Y),90)*${crimson}`;
  const dark = `gt(r(X,Y),80)*lt(g(X,Y),50)*lt(b(X,Y),60)*gt(r(X,Y),2*g(X,Y))*${crimson}`;
  const cond = `max(${bright},${dark})`;
  const e = `if(${cond},255,0)`;
  return [
    '-i', imagePath,
    '-vf', `scale=${mw}:${mh}:flags=area,format=gbrp,geq=r='${e}':g='${e}':b='${e}',format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ];
}

export interface Blob { x: number; y: number; w: number; h: number; area: number }

/** Largest 4-connected blob of non-zero pixels in a w*h mask, or null when the mask is empty. */
export function largestRedBlob(mask: Uint8Array, w: number, h: number): Blob | null {
  return selectLargest(redBlobs(mask, w, h));
}

function selectLargest(blobs: Blob[]): Blob | null {
  let best: Blob | null = null;
  for (const b of blobs) if (!best || b.area > best.area) best = b;
  return best;
}

/**
 * Picks the mouth among candidate blobs by shape: a wide flat blob (w/h >= 1.8) beats a round one (nose);
 * among wide blobs the largest area wins; with none wide, the largest overall. Null when empty.
 */
export function selectMouthBlob(blobs: Blob[]): Blob | null {
  return selectLargest(blobs.filter((b) => b.w >= WIDE_RATIO * b.h)) ?? selectLargest(blobs);
}

/** All 4-connected blobs of non-zero pixels in a w*h mask. */
export function redBlobs(mask: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Blob[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const push = (q: number) => { if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; } };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

async function detectMouth(imagePath: string, width: number, height: number, run: NonNullable<AnalyzeDeps['runFfmpegRaw']>): Promise<MouthBox | null> {
  const { mw, mh } = maskSize(width, height);
  const raw = await run(mouthMaskArgs(imagePath, width, height));
  if (raw.length < mw * mh) return null;
  const minArea = MIN_BLOB_RATIO * mw * mh;
  const blob = selectMouthBlob(redBlobs(raw.subarray(0, mw * mh), mw, mh).filter((b) => b.area >= minArea));
  if (!blob) return null;
  const sx = width / mw, sy = height / mh;
  const bx = blob.x * sx, by = blob.y * sy, bw = blob.w * sx, bh = blob.h * sy;
  const padX = Math.round(bw * MOUTH_PAD_RATIO), padY = Math.round(bh * MOUTH_PAD_RATIO);
  const x0 = Math.max(0, Math.round(bx) - padX), y0 = Math.max(0, Math.round(by) - padY);
  const x1 = Math.min(width, Math.round(bx + bw) + padX), y1 = Math.min(height, Math.round(by + bh) + padY);
  return normalizeMouthBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, width, height);
}

/** Grows a thin box (h < 0.4 w, e.g. a stitched smile line) to h = round(0.4 w), centred on it and clamped to the image. */
export function normalizeMouthBox(box: MouthBox, width: number, height: number): MouthBox {
  if (box.h >= MIN_BOX_ASPECT * box.w) return box;
  const h = Math.min(height, Math.round(MIN_BOX_ASPECT * box.w));
  const cy = box.y + box.h / 2;
  const y = Math.max(0, Math.min(height - h, Math.round(cy - h / 2)));
  return { x: box.x, y, w: box.w, h };
}

export const runFfmpegCapture: AnalyzeDeps['runFfmpegCapture'] = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', ...args]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

export async function analyzeCharacter(
  png: Buffer,
  imagePath: string,
  deps: AnalyzeDeps,
  opts: { margin?: number; similarity?: number; padRatio?: number } = {},
): Promise<CharacterAnalysis> {
  const margin = opts.margin ?? 10;
  const similarity = opts.similarity ?? 0.06;
  const padRatio = opts.padRatio ?? 0.02;
  const { width, height } = pngSize(png);
  const { r, g, b } = readPngPixel(png, margin, margin);
  const keyColor = `0x${hex2(r)}${hex2(g)}${hex2(b)}`;

  const stderr = await deps.runFfmpegCapture([
    '-i', imagePath,
    '-vf', `format=rgba,chromakey=${keyColor}:${similarity}:0.02,format=yuva420p,alphaextract,cropdetect=limit=0.05:round=2:reset=0:skip=0`,
    '-frames:v', '1', '-f', 'null', '-',
  ]);

  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('could not locate the character in the image');
  const [w, h, x, y] = last.slice(1).map(Number);
  if (w <= 0 || h <= 0) throw new Error('could not locate the character in the image');

  const padX = Math.round(w * padRatio);
  const padY = Math.round(h * padRatio);
  const x0 = Math.max(0, x - padX);
  const y0 = Math.max(0, y - padY);
  const mouth = deps.runFfmpegRaw ? await detectMouth(imagePath, width, height, deps.runFfmpegRaw) : null;
  return {
    keyColor,
    width,
    height,
    crop: { x: x0, y: y0, w: Math.min(width - x0, w + 2 * padX), h: Math.min(height - y0, h + 2 * padY) },
    mouth,
  };
}
