import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PiperClient, PIPER_VOICES, wavFromPcm } from '../src/clients/piper';
import { parsePiperHost } from '../src/config/piperHost';

type Event = { type: string; data?: Record<string, unknown>; payload?: Buffer };

// Real server shape: {type, version, data_length, payload_length?} then the data block, then payload.
function header(type: string, data?: object, payload?: Buffer, opts: { inline?: boolean } = {}): Buffer {
  const h: Record<string, unknown> = { type, version: '1.5.4' };
  const extraBuf = data && !opts.inline ? Buffer.from(JSON.stringify(data)) : undefined;
  if (data && opts.inline) h.data = data;
  if (extraBuf) h.data_length = extraBuf.length;
  if (payload) h.payload_length = payload.length;
  return Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), extraBuf ?? Buffer.alloc(0), payload ?? Buffer.alloc(0)]);
}

function parseEvents(buf: Buffer): Event[] {
  const out: Event[] = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) break;
    const h = JSON.parse(buf.subarray(off, nl).toString());
    off = nl + 1;
    if (h.data_length) off += h.data_length;
    let payload: Buffer | undefined;
    if (h.payload_length) {
      payload = buf.subarray(off, off + h.payload_length);
      off += h.payload_length;
    }
    out.push({ type: h.type, data: h.data, payload });
  }
  return out;
}

const servers: net.Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function fakeServer(
  respond: (sock: net.Socket, received: Event[]) => void,
): Promise<{ host: string; received: Event[] }> {
  const received: Event[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const events = parseEvents(buf);
      if (events.some((e) => e.type === 'synthesize')) {
        received.push(...events);
        buf = Buffer.alloc(0);
        respond(sock, received);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return { host: `tcp://127.0.0.1:${port}`, received };
}

const audio = { rate: 22050, width: 2, channels: 1, timestamp: null };

test('synthesize returns a WAV built from chunks and sends the voice preset', async () => {
  const pcm1 = Buffer.from([1, 0, 2, 0]);
  const pcm2 = Buffer.from([3, 0]);
  const { host, received } = await fakeServer((sock) => {
    const all = Buffer.concat([
      header('audio-start', audio),
      header('audio-chunk', audio, pcm1),
      header('audio-chunk', audio, pcm2),
      header('audio-stop'),
    ]);
    // dribble bytes to exercise partial reads
    let i = 0;
    const t = setInterval(() => {
      sock.write(all.subarray(i, i + 7));
      i += 7;
      if (i >= all.length) {
        clearInterval(t);
        sock.end();
      }
    }, 1);
  });
  const wav = await new PiperClient(host).synthesize({ text: 'hola', voice: 'female' });
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
  const req = received.find((e) => e.type === 'synthesize');
  assert.deepEqual(req?.data, { text: 'hola', voice: { name: PIPER_VOICES.female.name, speaker: 1 } });
});

test('male preset omits speaker; raw model names pass through', async () => {
  const { host, received } = await fakeServer((sock) => {
    sock.write(Buffer.concat([header('audio-start', audio), header('audio-stop')]));
    sock.end();
  });
  const c = new PiperClient(host);
  await c.synthesize({ text: 'a', voice: 'male' });
  await c.synthesize({ text: 'b', voice: 'es_ES-carlfm-x_low' });
  const reqs = received.filter((e) => e.type === 'synthesize');
  assert.deepEqual(reqs[0].data?.voice, { name: 'es_ES-davefx-medium' });
  assert.deepEqual(reqs[1].data?.voice, { name: 'es_ES-carlfm-x_low' });
});

test('server error event is thrown with its text', async () => {
  const { host } = await fakeServer((sock) => {
    sock.write(header('error', { text: 'voice not found', code: 'x' }));
    sock.end();
  });
  await assert.rejects(new PiperClient(host).synthesize({ text: 'a', voice: 'male' }), /voice not found/);
});

test('connection refused is a descriptive error', async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  await assert.rejects(
    new PiperClient(`tcp://127.0.0.1:${port}`).synthesize({ text: 'a', voice: 'male' }),
    /Piper unreachable/,
  );
});

test('timeout when the server never answers', async () => {
  const { host } = await fakeServer(() => {});
  await assert.rejects(
    new PiperClient(host, { timeoutMs: 50 }).synthesize({ text: 'a', voice: 'male' }),
    /timed out/i,
  );
});

test('connection closed before audio-stop is an error', async () => {
  const { host } = await fakeServer((sock) => {
    sock.write(header('audio-start', audio));
    sock.end();
  });
  await assert.rejects(new PiperClient(host).synthesize({ text: 'a', voice: 'male' }), /closed before audio-stop/);
});

test('rejects invalid host and empty text', async () => {
  await assert.rejects(new PiperClient('http://x:1').synthesize({ text: 'a', voice: 'male' }), /tcp:\/\//);
  await assert.rejects(new PiperClient('tcp://127.0.0.1:1').synthesize({ text: ' ', voice: 'male' }), /text/);
});

test('wavFromPcm writes a 44-byte header', () => {
  const wav = wavFromPcm(Buffer.from([0, 0]), { rate: 16000, width: 2, channels: 1 });
  assert.equal(wav.length, 46);
  assert.equal(wav.readUInt32LE(4), 38);
  assert.equal(wav.readUInt32LE(28), 32000);
});

test('inline data on server events is also accepted', async () => {
  const { host } = await fakeServer((sock) => {
    sock.write(
      Buffer.concat([
        header('audio-start', audio, undefined, { inline: true }),
        header('audio-chunk', audio, Buffer.from([5, 0]), { inline: true }),
        header('audio-stop'),
      ]),
    );
    sock.end();
  });
  const wav = await new PiperClient(host).synthesize({ text: 'a', voice: 'male' });
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.deepEqual([...wav.subarray(44)], [5, 0]);
});

for (const [label, field] of [
  ['negative data_length', { data_length: -5 }],
  ['fractional data_length', { data_length: 1.5 }],
  ['string payload_length', { payload_length: '10' }],
  ['oversized payload_length', { payload_length: 64 * 1024 * 1024 + 1 }],
  ['oversized combined lengths', { data_length: 40 * 1024 * 1024, payload_length: 40 * 1024 * 1024 }],
] as const) {
  test(`rejects a frame with ${label}`, async () => {
    const { host } = await fakeServer((sock) => {
      sock.write(JSON.stringify({ type: 'audio-chunk', version: '1.5.4', ...field }) + '\n');
    });
    await assert.rejects(
      new PiperClient(host, { timeoutMs: 2000 }).synthesize({ text: 'a', voice: 'male' }),
      /invalid frame length/i,
    );
  });
}

test('parsePiperHost parses valid hosts and rejects malformed ones', () => {
  assert.deepEqual(parsePiperHost('tcp://spark:10200'), { host: 'spark', port: 10200 });
  for (const bad of ['http://x:1', 'tcp://x', 'tcp://x:0', 'tcp://x:70000', 'tcp://:1', '']) {
    assert.equal(parsePiperHost(bad), null, bad);
  }
});
