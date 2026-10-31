import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';

import {
  analyzeCharacter,
  pngSize,
  readPngPixel,
  runFfmpegCapture,
} from '../src/media/characterAnalysis';

// ---------------------------------------------------------------------------
// Minimal PNG encoder (IHDR + one IDAT + IEND) so tests do not need real
// images on disk. zlib.crc32 exists in Node 22.
// ---------------------------------------------------------------------------

function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Apply a PNG row filter (0..4) to a raw row, given the previous raw row. */
function encodeRow(raw: Buffer, prev: Buffer | null, filter: number, bytesPerPixel: number): Buffer {
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const a = i >= bytesPerPixel ? raw[i - bytesPerPixel] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
    let p = 0;
    if (filter === 1) p = a;
    else if (filter === 2) p = b;
    else if (filter === 3) p = (a + b) >> 1;
    else if (filter === 4) p = paethPredictor(a, b, c);
    out[i] = (raw[i] - p) & 0xff;
  }
  return out;
}

interface MakePngOpts {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
  filter?: number;
  pixelAt?: (x: number, y: number) => number[]; // 0..255 per channel
  rawRows?: Buffer[]; // prebuilt raw bytes per row (palette index / 16-bit placeholder)
}

function makePng(o: MakePngOpts): Buffer {
  const bitDepth = o.bitDepth ?? 8;
  const colorType = o.colorType ?? 2;
  const filter = o.filter ?? 0;
  const interlace = o.interlace ?? 0;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr.writeUInt8(bitDepth, 8);
  ihdr.writeUInt8(colorType, 9);
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr.writeUInt8(interlace, 12);
  const scanlines: Buffer[] = [];
  let prev: Buffer | null = null;
  for (let y = 0; y < o.height; y++) {
    const raw = o.rawRows
      ? o.rawRows[y]
      : Buffer.from(o.pixelAt ? Array.from({ length: o.width }, (__, x) => o.pixelAt!(x, y)).flat() : []);
    scanlines.push(Buffer.concat([Buffer.from([filter]), encodeRow(raw, prev, filter, channels)]));
    prev = raw;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(scanlines))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic pixel values in 0..255, varied in both axes.
const PIX = (x: number, y: number): [number, number, number, number] => [
  (x * 37 + y * 11 + 5) & 0xff,
  (x * 13 + y * 41 + 40) & 0xff,
  (x * 29 + y * 17 + 90) & 0xff,
  (x * 7 + y * 3 + 200) & 0xff,
];

const PROBE: Array<[number, number]> = [
  [0, 0],
  [3, 0],
  [1, 2],
  [2, 1],
  [3, 3],
];

// ------------------------------- pngSize ------------------------------------

test('pngSize reports the 4x4 RGB image size', () => {
  const png = makePng({ width: 4, height: 4, filter: 1, pixelAt: (x, y) => PIX(x, y).slice(0, 3) });
  assert.deepEqual(pngSize(png), { width: 4, height: 4 });
});

test('pngSize reports the 4x4 RGBA image size', () => {
  const png = makePng({ width: 4, height: 4, colorType: 6, filter: 4, pixelAt: (x, y) => PIX(x, y) });
  assert.deepEqual(pngSize(png), { width: 4, height: 4 });
});

// ----------------------------- readPngPixel ---------------------------------

for (const filter of [0, 1, 2, 3, 4]) {
  test(`readPngPixel decodes 8-bit RGB rows with filter ${filter}`, () => {
    const png = makePng({ width: 4, height: 4, filter, pixelAt: (x, y) => PIX(x, y).slice(0, 3) });
    for (const [x, y] of PROBE) {
      const [r, g, b] = PIX(x, y);
      assert.deepEqual(readPngPixel(png, x, y), { r, g, b }, `pixel (${x}, ${y}) filter ${filter}`);
    }
  });

  test(`readPngPixel decodes 8-bit RGBA rows with filter ${filter}`, () => {
    const png = makePng({ width: 4, height: 4, colorType: 6, filter, pixelAt: (x, y) => PIX(x, y) });
    for (const [x, y] of PROBE) {
      const [r, g, b] = PIX(x, y);
      const p = readPngPixel(png, x, y);
      assert.deepEqual(p, { r, g, b }, `pixel (${x}, ${y}) filter ${filter}`);
    }
  });
}

test('readPngPixel throws for non-PNG input', () => {
  const junk = Buffer.from('definitely not a png file');
  assert.throws(() => readPngPixel(junk, 0, 0), /PNG/i);
  assert.throws(() => pngSize(junk), /PNG/i);
});

test('readPngPixel throws for a 16-bit image', () => {
  const png = makePng({ width: 2, height: 2, bitDepth: 16, rawRows: [Buffer.alloc(12), Buffer.alloc(12)] });
  assert.throws(() => readPngPixel(png, 0, 0), /bit depth/i);
});

test('readPngPixel throws for a palette image', () => {
  const png = makePng({ width: 2, height: 2, colorType: 3, rawRows: [Buffer.from([0, 1]), Buffer.from([1, 0])] });
  assert.throws(() => readPngPixel(png, 0, 0), /colour type/i);
});

test('readPngPixel throws for an interlaced image', () => {
  const png = makePng({ width: 4, height: 4, interlace: 1, pixelAt: (x, y) => PIX(x, y).slice(0, 3) });
  assert.throws(() => readPngPixel(png, 0, 0), /interlaced/i);
});

test('readPngPixel throws for out-of-range coordinates', () => {
  const png = makePng({ width: 4, height: 4, pixelAt: (x, y) => PIX(x, y).slice(0, 3) });
  assert.throws(() => readPngPixel(png, 4, 0), /out of range/i);
  assert.throws(() => readPngPixel(png, 0, 4), /out of range/i);
  assert.throws(() => readPngPixel(png, -1, 0), /out of range/i);
});

// ---------------------------- analyzeCharacter ------------------------------

const UNIFORM = (v1: number, v2: number, v3: number) => (_x: number, _y: number) => [v1, v2, v3];

function fakeCapture(stderr: string) {
  const calls: string[][] = [];
  return {
    calls,
    runFfmpegCapture: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(stderr);
    },
  };
}

const CROP_LINES = [
  'frame=    0 fps=0.0 q=-0.0 size=N/A time=N/A bitrate=N/A speed=N/A',
  '[Parsed_cropdetect_3 @ 0x55d4a1c2b400] crop=80:100:10:5',
  '[Parsed_cropdetect_3 @ 0x55d4a1c2b400] crop=60:80:20:10',
  '[Parsed_cropdetect_3 @ 0x55d4a1c2b400] n=16 s=0.998828 p=0.998828',
  '[Parsed_cropdetect_3 @ 0x55d4a1c2b400] crop=40:50:30:25',
].join('\n');

test('analyzeCharacter uses the last crop line, samples the key colour and builds the ffmpeg args', async () => {
  const png = makePng({ width: 100, height: 100, pixelAt: UNIFORM(120, 60, 30) });
  const fake = fakeCapture(CROP_LINES);
  const result = await analyzeCharacter(png, '/tmp/puppet.png', fake);

  assert.equal(result.keyColor, '0x783c1e');
  assert.equal(result.width, 100);
  assert.equal(result.height, 100);
  // last crop (40:50:30:25) padded by 0.02 (round(40*.02)=1, round(50*.02)=1)
  assert.deepEqual(result.crop, { x: 29, y: 24, w: 42, h: 52 });

  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], [
    '-i',
    '/tmp/puppet.png',
    '-vf',
    'format=rgba,chromakey=0x783c1e:0.06:0.02,format=yuva420p,alphaextract,cropdetect=limit=0.05:round=2:reset=0:skip=0',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
});

test('analyzeCharacter honours custom margin / similarity / padRatio', async () => {
  const png = makePng({ width: 100, height: 100, pixelAt: UNIFORM(200, 100, 50) });
  const fake = fakeCapture(CROP_LINES);
  const result = await analyzeCharacter(png, '/tmp/puppet.png', fake, { margin: 2, similarity: 0.1, padRatio: 0.1 });

  assert.equal(result.keyColor, '0xc86432');
  // padRatio 0.1 -> pw=4, ph=5
  assert.deepEqual(result.crop, { x: 26, y: 20, w: 48, h: 60 });
  assert.ok(fake.calls[0]!.join(' ').includes('chromakey=0xc86432:0.1:0.02'));
});

test('analyzeCharacter clamps the padded box to the image borders', async () => {
  const png = makePng({ width: 100, height: 100, pixelAt: UNIFORM(10, 20, 30) });
  const rightBottom = fakeCapture('[Parsed_cropdetect_3 @ 0x1] crop=90:90:95:95\n');
  const r = await analyzeCharacter(png, '/tmp/p.png', rightBottom);
  // x=95-2=93, w = min(100-93, 90+4) = 7
  assert.deepEqual(r.crop, { x: 93, y: 93, w: 7, h: 7 });

  const leftTop = fakeCapture('[Parsed_cropdetect_3 @ 0x1] crop=60:60:0:0\n');
  const r2 = await analyzeCharacter(png, '/tmp/p.png', leftTop);
  assert.deepEqual(r2.crop, { x: 0, y: 0, w: 62, h: 62 });
});

test('analyzeCharacter throws when no crop= line appears', async () => {
  const png = makePng({ width: 20, height: 20, pixelAt: UNIFORM(1, 2, 3) });
  const fake = fakeCapture('frame=    1 fps=0.0 \r\n[aac @ 0x1] something else\n');
  await assert.rejects(analyzeCharacter(png, '/tmp/p.png', fake), /could not locate the character/i);
});

test('analyzeCharacter throws when the detected box has zero width or height', async () => {
  const png = makePng({ width: 20, height: 20, pixelAt: UNIFORM(1, 2, 3) });
  const fake = fakeCapture('[Parsed_cropdetect_3 @ 0x1] crop=0:50:0:0\n');
  await assert.rejects(analyzeCharacter(png, '/tmp/p.png', fake), /could not locate the character/i);
});

test('runFfmpegCapture is exported as a function (default implementation)', () => {
  assert.equal(typeof runFfmpegCapture, 'function');
});
