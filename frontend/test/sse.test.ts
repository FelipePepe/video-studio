import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../src/api/client';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  await parseSseStream(streamOf(chunks), (d) => out.push(d));
  return out;
}

describe('parseSseStream', () => {
  it('delivers one frame per data block', async () => {
    expect(await collect(['data: {"a":1}\n\n'])).toEqual([{ a: 1 }]);
  });

  it('handles several frames in a single chunk, in order', async () => {
    expect(await collect(['data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n'])).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });

  it('reassembles frames split across chunks, even mid-character', async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"t":"ñ"}\n\n');
    const mid = bytes.indexOf(0xc3) + 1; // split inside the two-byte "ñ"
    const out: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, mid));
        c.enqueue(bytes.slice(mid));
        c.close();
      },
    });
    await parseSseStream(stream, (d) => out.push(d));
    expect(out).toEqual([{ t: 'ñ' }]);
    expect(await collect(['da', 'ta: {"a"', ':1}\n', '\ndata: {"b":2}\n\n'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores comment frames such as pings', async () => {
    expect(await collect([': ping\n\ndata: {"a":1}\n\n: ping\n\n'])).toEqual([{ a: 1 }]);
  });

  it('skips a malformed JSON frame without crashing', async () => {
    expect(await collect(['data: {oops\n\ndata: {"ok":true}\n\n'])).toEqual([{ ok: true }]);
  });

  it('supports CRLF line endings', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('flushes a trailing frame that lacks the final blank line', async () => {
    expect(await collect(['data: {"a":1}\n'])).toEqual([{ a: 1 }]);
  });
});
