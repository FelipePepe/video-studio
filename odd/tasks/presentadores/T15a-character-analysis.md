# T15a — analyse a generated character: key colour and bounding box

## Goal
Given a character PNG (felt puppet on a flat green background), return what the sprite builder needs: the background key colour (sampled from the image corner) and the bounding box of the character. Pure Node + ffmpeg, no new dependencies. The ffmpeg runner is injectable so tests do not need ffmpeg.

## Files
- `backend/src/media/characterAnalysis.ts` (new)
- `backend/test/characterAnalysis.test.ts` (new)

## API (exact)
```ts
export interface CharacterAnalysis {
  keyColor: string;                                   // '0xRRGGBB' sampled at (margin, margin) of the image
  width: number; height: number;                      // image size in px
  crop: { x: number; y: number; w: number; h: number }; // bbox of the non-background area, padded
}
/** Reads one pixel of an 8-bit non-interlaced RGB or RGBA PNG (colour type 2 or 6) using only node:zlib. */
export function readPngPixel(png: Buffer, x: number, y: number): { r: number; g: number; b: number };
export function pngSize(png: Buffer): { width: number; height: number };

export interface AnalyzeDeps {
  /** Runs ffmpeg with these args and resolves with its STDERR text (cropdetect prints there). */
  runFfmpegCapture: (args: string[]) => Promise<string>;
}
export function analyzeCharacter(png: Buffer, imagePath: string, deps: AnalyzeDeps, opts?: { margin?: number; similarity?: number; padRatio?: number }): Promise<CharacterAnalysis>;
```

## Behaviour
- `readPngPixel`: parse chunks, concatenate IDAT, `zlib.inflateSync`, undo the five PNG row filters (None, Sub, Up, Average, Paeth) for rows 0..y only, return the pixel. Throw clear Errors for non-PNG, interlaced, bit depth != 8, colour type other than 2/6, or out-of-range x/y.
- `analyzeCharacter`: `margin` default 10 -> `keyColor` from `readPngPixel(png, margin, margin)` as `0x%02x%02x%02x`. Bbox: build the ffmpeg args `['-i', imagePath, '-vf', `format=rgba,chromakey=${keyColor}:${similarity}:0.02,alphaextract,cropdetect=limit=0.05:round=2:reset=0`, '-frames:v', '1', '-f', 'null', '-']` (`similarity` default 0.06), call `deps.runFfmpegCapture`, parse the LAST `crop=W:H:X:Y` in the output with a regex, pad the box by `padRatio` (default 0.02 of each dimension, clamped to the image) and return it. If no `crop=` is found or W/H <= 0, throw `Error('could not locate the character in the image')`.
- Also export a default `runFfmpegCapture` implementation built on `node:child_process.spawn('ffmpeg', ['-hide_banner', ...args])` that resolves with stderr and rejects on a non-zero exit (keep it small; it is not unit-tested, `analyzeCharacter` takes it by injection).

## Tests (write first, must fail first)
Build PNGs in the test with `node:zlib` (write a tiny encoder helper in the test file: IHDR + one IDAT + IEND with CRC32 — `zlib.crc32` exists in Node 22; if it does not, compute CRC32 by table):
- `pngSize`, `readPngPixel` on a 4x4 RGB image and a 4x4 RGBA image for each filter type (generate rows with filters 0..4 so every unfilter branch is exercised; the expected pixel values are the original, unfiltered ones).
- Errors: not a PNG, 16-bit, palette, out-of-range pixel.
- `analyzeCharacter` with a fake `runFfmpegCapture` returning stderr text containing several `crop=` lines: it uses the last one, pads and clamps to the image, builds the expected ffmpeg args (check the `-vf` contains the sampled key colour), and throws when no `crop=` appears.

## Acceptance
- `cd backend && node --test --import tsx test/characterAnalysis.test.ts` green; `pnpm typecheck` green.

## Do NOT touch
Any existing file.

## Rules (apply to every task)
- Strict TDD: write the failing test FIRST, run it, confirm it fails for the right reason, then implement.
- Backend tests: `cd backend && node --test --import tsx test/<file>.test.ts`. Also run `pnpm typecheck` from the repo root at the end.
- Touch ONLY the files listed under "Files". Do not run git commands (no commit, no checkout). Do not build. No new dependencies.
- Keep changes minimal; ~400 changed lines is only a planning heuristic, not a target.
- Code, comments and test names in English.
- Finish with a short report: files changed, tests added/changed, test output summary.
