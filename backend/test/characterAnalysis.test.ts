import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';

import {
  analyzeCharacter,
  largestRedBlob,
  mouthMaskArgs,
  normalizeMouthBox,
  selectMouthBlob,
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

// ------------------------------ mouth detection -----------------------------

function maskWith(w: number, h: number, rects: Array<[number, number, number, number]>): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const [x, y, rw, rh] of rects) for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) m[j * w + i] = 255;
  return m;
}

test('largestRedBlob returns null for an empty mask', () => {
  assert.equal(largestRedBlob(new Uint8Array(100 * 100), 100, 100), null);
});

test('largestRedBlob picks the bigger of two blobs', () => {
  const m = maskWith(100, 100, [[5, 5, 6, 6], [40, 60, 20, 10]]);
  assert.deepEqual(largestRedBlob(m, 100, 100), { x: 40, y: 60, w: 20, h: 10, area: 200 });
});

test('largestRedBlob prefers a mouth-sized blob below a nose-sized blob', () => {
  const m = maskWith(100, 100, [[45, 30, 8, 8], [30, 70, 40, 12]]);
  const b = largestRedBlob(m, 100, 100)!;
  assert.deepEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: 30, y: 70, w: 40, h: 12 });
});

test('largestRedBlob uses 4-neighbour connectivity (diagonals do not join)', () => {
  const m = maskWith(10, 10, [[1, 1, 1, 1], [2, 2, 1, 1]]);
  assert.equal(largestRedBlob(m, 10, 10)!.area, 1);
});

test('mouthMaskArgs downscales to <=256 and emits a gray rawvideo mask', () => {
  const args = mouthMaskArgs('/tmp/p.png', 1024, 1024);
  assert.deepEqual(args.slice(0, 2), ['-i', '/tmp/p.png']);
  const vf = args[args.indexOf('-vf') + 1]!;
  assert.ok(vf.includes('scale=256:256'));
  assert.ok(vf.includes('gt(r(X,Y),140)') && vf.includes('lt(g(X,Y),70)') && vf.includes('lt(b(X,Y),90)'));
  // dark maroon lips (open-mouth shading, e.g. Leo) must also count as mouth
  assert.ok(vf.includes('gt(r(X,Y),80)') && vf.includes('lt(g(X,Y),50)') && vf.includes('lt(b(X,Y),60)') && vf.includes('max('));
  // orange hair (blue < green) must not match: lips are crimson (blue >= 0.8 green) in BOTH clauses
  assert.equal(vf.split('gte(b(X,Y),0.8*g(X,Y))').length - 1, 6); // 2 clauses x r,g,b expressions
  assert.ok(vf.endsWith('format=gray'));
  assert.deepEqual(args.slice(-5), ['-frames:v', '1', '-f', 'rawvideo', '-']);
  assert.ok(mouthMaskArgs('/tmp/p.png', 512, 1024).join(' ').includes('scale=128:256'));
  assert.ok(mouthMaskArgs('/tmp/p.png', 100, 50).join(' ').includes('scale=100:50'));
});

test('analyzeCharacter maps the mouth blob back to full-image pixels', async () => {
  const png = makePng({ width: 512, height: 512, pixelAt: UNIFORM(1, 2, 3) });
  // 256x256 mask (scale 2): blob x=100..119, y=180..189 (w20,h10)
  const mask = Buffer.from(maskWith(256, 256, [[100, 180, 20, 10]]));
  const cap = fakeCapture(CROP_LINES);
  const calls: string[][] = [];
  const r = await analyzeCharacter(png, '/tmp/p.png', {
    ...cap,
    runFfmpegRaw: (a) => { calls.push(a); return Promise.resolve(mask); },
  });
  assert.equal(calls.length, 1);
  // full: x=200,y=360,w=40,h=20; pad 3% -> 1.2/0.6 -> round 1 / 1
  assert.deepEqual(r.mouth, { x: 199, y: 359, w: 42, h: 22 });
});

test('analyzeCharacter clamps the padded mouth to the image', async () => {
  const png = makePng({ width: 256, height: 256, pixelAt: UNIFORM(1, 2, 3) });
  const mask = Buffer.from(maskWith(256, 256, [[0, 0, 100, 100]]));
  const r = await analyzeCharacter(png, '/tmp/p.png', { ...fakeCapture(CROP_LINES), runFfmpegRaw: () => Promise.resolve(mask) });
  assert.deepEqual(r.mouth, { x: 0, y: 0, w: 103, h: 103 });
});

test('analyzeCharacter mouth is null without runFfmpegRaw', async () => {
  const png = makePng({ width: 100, height: 100, pixelAt: UNIFORM(1, 2, 3) });
  assert.equal((await analyzeCharacter(png, '/tmp/p.png', fakeCapture(CROP_LINES))).mouth, null);
});

test('analyzeCharacter mouth is null for an empty or tiny mask', async () => {
  const png = makePng({ width: 100, height: 100, pixelAt: UNIFORM(1, 2, 3) });
  const empty = await analyzeCharacter(png, '/tmp/p.png', { ...fakeCapture(CROP_LINES), runFfmpegRaw: () => Promise.resolve(Buffer.alloc(100 * 100)) });
  assert.equal(empty.mouth, null);
  const tiny = Buffer.from(maskWith(100, 100, [[10, 10, 4, 4]])); // 16/10000 = 0.16 % < 0.3 %
  const t = await analyzeCharacter(png, '/tmp/p.png', { ...fakeCapture(CROP_LINES), runFfmpegRaw: () => Promise.resolve(tiny) });
  assert.equal(t.mouth, null);
});

// ---------------------- thin-smile selection / normalisation ----------------------

const blob = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, area: w * h });

test('selectMouthBlob: a thin wide line beats a larger round blob (nose)', () => {
  const nose = blob(100, 100, 30, 30);
  const line = blob(80, 160, 100, 4);
  assert.equal(selectMouthBlob([nose, line]), line);
});

test('selectMouthBlob: among wide blobs the larger area wins', () => {
  const a = blob(0, 0, 60, 6), b = blob(0, 50, 100, 8);
  assert.equal(selectMouthBlob([a, b]), b);
});

test('selectMouthBlob: with no wide blob the largest one wins', () => {
  const a = blob(0, 0, 10, 10), b = blob(40, 40, 20, 20);
  assert.equal(selectMouthBlob([a, b]), b);
});

test('selectMouthBlob: empty list gives null', () => {
  assert.equal(selectMouthBlob([]), null);
});

test('normalizeMouthBox leaves a wide-mouth box untouched', () => {
  assert.deepEqual(normalizeMouthBox({ x: 346, y: 491, w: 340, h: 174 }, 1024, 1024), { x: 346, y: 491, w: 340, h: 174 });
});

test('normalizeMouthBox grows a thin smile to h = 0.4 w centred on the line', () => {
  assert.deepEqual(normalizeMouthBox({ x: 390, y: 700, w: 260, h: 20 }, 1024, 1024), { x: 390, y: 658, w: 260, h: 104 });
});

test('normalizeMouthBox clamps the grown box to the image', () => {
  assert.deepEqual(normalizeMouthBox({ x: 10, y: 5, w: 200, h: 6 }, 1024, 1024), { x: 10, y: 0, w: 200, h: 80 });
  assert.deepEqual(normalizeMouthBox({ x: 10, y: 1018, w: 200, h: 6 }, 1024, 1024), { x: 10, y: 944, w: 200, h: 80 });
});

test('analyzeCharacter picks a thin smile over a bigger round nose and widens it', async () => {
  const png = makePng({ width: 512, height: 512, pixelAt: UNIFORM(1, 2, 3) });
  // 256 mask, scale 2: nose 20x20 (area 400), smile 100x4 (area 400 tie on purpose smaller: 100x3=300)
  const mask = Buffer.from(maskWith(256, 256, [[120, 100, 20, 20], [80, 150, 100, 3]]));
  const r = await analyzeCharacter(png, '/tmp/p.png', { ...fakeCapture(CROP_LINES), runFfmpegRaw: () => Promise.resolve(mask) });
  // smile full: x=160,y=300,w=200,h=6; pad 3% -> 6 / 0 ; then h grows to 0.4*212 = 85 centred
  assert.equal(r.mouth!.x, 154);
  assert.equal(r.mouth!.w, 212);
  assert.equal(r.mouth!.h, 85);
  assert.ok(r.mouth!.y < 300 && r.mouth!.y + r.mouth!.h > 306);
});
