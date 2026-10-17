import net from 'node:net';
import { parsePiperHost, type PiperTarget } from '../config/piperHost';
import { wavFromPcm, type PcmFormat } from '../media/wav';

export { wavFromPcm, type PcmFormat };

export interface PiperVoice {
  name: string;
  speaker?: number;
}

export const PIPER_VOICES: Record<'male' | 'female', PiperVoice> = {
  male: { name: 'es_ES-davefx-medium' },
  female: { name: 'es_ES-sharvard-medium', speaker: 1 },
};

export interface PiperClientOptions {
  connect?: typeof net.connect;
  timeoutMs?: number;
}

export interface PiperSynthesizeOptions {
  text: string;
  voice: string;
  // Accepted for API stability; the Wyoming synthesize event has no speed field.
  speed?: number;
}

function resolveVoice(voice: string): PiperVoice {
  return voice === 'male' || voice === 'female' ? PIPER_VOICES[voice] : { name: voice };
}

function parseHost(host: string): PiperTarget {
  const target = parsePiperHost(host);
  if (!target) throw new Error(`Piper host must look like tcp://host:port, got "${host}"`);
  return target;
}

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function validLength(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

interface WyomingHeader {
  type: string;
  data?: Record<string, unknown>;
  data_length?: number;
  payload_length?: number;
}

export class PiperClient {
  private readonly connect: typeof net.connect;
  private readonly timeoutMs: number;

  constructor(
    readonly host: string,
    opts: PiperClientOptions = {},
  ) {
    this.connect = opts.connect ?? net.connect;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async synthesize(opts: PiperSynthesizeOptions): Promise<Buffer> {
    if (!opts.text.trim()) throw new Error('Piper text must not be empty');
    const target = parseHost(this.host);
    const voice = resolveVoice(opts.voice);

    return new Promise<Buffer>((resolve, reject) => {
      const socket = this.connect({ host: target.host, port: target.port });
      const chunks: Buffer[] = [];
      let fmt: PcmFormat | undefined;
      let buf = Buffer.alloc(0);
      let settled = false;

      const finish = (err: Error | null, result?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(result as Buffer);
      };
      const timer = setTimeout(
        () => finish(new Error(`Piper request timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      const handle = (h: WyomingHeader, extra: Record<string, unknown>, payload: Buffer) => {
        const data = { ...(h.data ?? {}), ...extra };
        if (h.type === 'error') {
          finish(new Error(`Piper error: ${String(data.text ?? data.code ?? 'unknown')}`));
        } else if (h.type === 'audio-start') {
          fmt = { rate: Number(data.rate), width: Number(data.width), channels: Number(data.channels) };
        } else if (h.type === 'audio-chunk') {
          fmt ??= { rate: Number(data.rate), width: Number(data.width), channels: Number(data.channels) };
          chunks.push(payload);
        } else if (h.type === 'audio-stop') {
          if (!fmt) finish(new Error('Piper sent audio-stop without audio-start'));
          else finish(null, wavFromPcm(Buffer.concat(chunks), fmt));
        }
      };

      const drain = () => {
        for (;;) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          let h: WyomingHeader;
          try {
            h = JSON.parse(buf.subarray(0, nl).toString('utf8')) as WyomingHeader;
          } catch {
            finish(new Error('Piper sent a malformed event header'));
            return;
          }
          const dataLen = h.data_length ?? 0;
          const payloadLen = h.payload_length ?? 0;
          if (!validLength(dataLen) || !validLength(payloadLen) || dataLen + payloadLen > MAX_FRAME_BYTES) {
            finish(new Error('Piper sent an invalid frame length'));
            return;
          }
          const total = nl + 1 + dataLen + payloadLen;
          if (buf.length < total) return;
          let extra: Record<string, unknown> = {};
          if (dataLen > 0) {
            try {
              extra = JSON.parse(buf.subarray(nl + 1, nl + 1 + dataLen).toString('utf8'));
            } catch {
              finish(new Error('Piper sent malformed event data'));
              return;
            }
          }
          const payload = buf.subarray(nl + 1 + dataLen, total);
          buf = buf.subarray(total);
          handle(h, extra, payload);
          if (settled) return;
        }
      };

      socket.on('connect', () => {
        const data: Record<string, unknown> = {
          text: opts.text,
          voice: voice.speaker === undefined ? { name: voice.name } : { name: voice.name, speaker: voice.speaker },
        };
        socket.write(JSON.stringify({ type: 'synthesize', data }) + '\n');
      });
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        drain();
      });
      socket.on('error', (e) => finish(new Error(`Piper unreachable at ${this.host}: ${e.message}`)));
      socket.on('close', () => finish(new Error('Piper connection closed before audio-stop')));
    });
  }

  /** Lists the voices installed on the Piper server (Wyoming `describe` event). */
  async listVoices(): Promise<PiperVoice[]> {
    const target = parseHost(this.host);
    return new Promise<PiperVoice[]>((resolve, reject) => {
      const socket = this.connect({ host: target.host, port: target.port });
      let buf = Buffer.alloc(0);
      let settled = false;
      const settleOk = (v: PiperVoice[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(v);
      };
      const settleError = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(e);
      };
      const timer = setTimeout(
        () => settleError(new Error(`Piper request timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      socket.on('connect', () => {
        socket.write(JSON.stringify({ type: 'describe' }) + '\n');
      });
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        let h: WyomingHeader;
        try {
          h = JSON.parse(buf.subarray(0, nl).toString('utf8')) as WyomingHeader;
        } catch {
          return settleError(new Error('Piper sent a malformed event header'));
        }
        const dataLen = h.data_length ?? 0;
        if (!validLength(dataLen) || dataLen > MAX_FRAME_BYTES) {
          return settleError(new Error('Piper sent an invalid frame length'));
        }
        const total = nl + 1 + dataLen;
        if (buf.length < total) return;
        let data: Record<string, unknown> = { ...(h.data ?? {}) };
        if (dataLen > 0) {
          try {
            data = { ...data, ...JSON.parse(buf.subarray(nl + 1, nl + 1 + dataLen).toString('utf8')) };
          } catch {
            return settleError(new Error('Piper sent malformed event data'));
          }
        }
        if (h.type === 'error') {
          return settleError(new Error(`Piper error: ${String(data.text ?? data.code ?? 'unknown')}`));
        }
        if (h.type === 'describe') {
          const voices = data.voices;
          if (Array.isArray(voices) && voices.every((v) => v !== null && typeof (v as PiperVoice).name === 'string')) {
            return settleOk(voices as PiperVoice[]);
          }
          return settleError(new Error('Piper describe event has no voices array'));
        }
        buf = buf.subarray(total); // ignore keep-alives and other events
      });
      socket.on('error', (e) => settleError(new Error(`Piper unreachable at ${this.host}: ${e.message}`)));
      socket.on('close', () => settleError(new Error('Piper connection closed before describe')));
    });
  }
}
