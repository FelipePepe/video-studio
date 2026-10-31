import { spawn } from 'node:child_process';
import zlib from 'node:zlib';

export interface CharacterAnalysis {
  keyColor: string; // '0xRRGGBB' sampled at (margin, margin) of the image
  width: number;
  height: number;
  crop: { x: number; y: number; w: number; h: number }; // bbox of the non-background area, padded
}

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
    '-vf', `format=rgba,chromakey=${keyColor}:${similarity}:0.02,alphaextract,cropdetect=limit=0.05:round=2:reset=0`,
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
  return {
    keyColor,
    width,
    height,
    crop: { x: x0, y: y0, w: Math.min(width - x0, w + 2 * padX), h: Math.min(height - y0, h + 2 * padY) },
  };
}
