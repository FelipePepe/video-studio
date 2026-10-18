export interface PcmFormat {
  rate: number;
  width: number;
  channels: number;
}

export interface ParsedWav {
  format: PcmFormat;
  dataOffset: number;
  dataLength: number;
}

const HEADER_BYTES = 44;

export function wavFromPcm(pcm: Buffer, fmt: PcmFormat): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  const byteRate = fmt.rate * fmt.width * fmt.channels;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(fmt.width * fmt.channels, 32);
  header.writeUInt16LE(fmt.width * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let format: PcmFormat | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('Truncated WAV fmt chunk');
      if (buf.readUInt16LE(body) !== 1) throw new Error('Only PCM WAV is supported');
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const width = buf.readUInt16LE(body + 14) / 8;
      if (!(channels > 0) || !(rate > 0) || !Number.isInteger(width) || width < 1) {
        throw new Error('Invalid WAV format');
      }
      format = { rate, width, channels };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk before fmt chunk');
      return { format, dataOffset: body, dataLength: Math.min(size, buf.length - body) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(format ? 'WAV has no data chunk' : 'WAV has no fmt chunk');
}

export function wavDurationSec(buf: Buffer): number {
  const { format, dataLength } = parseWav(buf);
  return dataLength / (format.rate * format.width * format.channels);
}

export function wavSilence(durationSec: number, fmt: PcmFormat): Buffer {
  if (!(durationSec > 0)) throw new Error('silence duration must be greater than 0');
  const frameBytes = fmt.width * fmt.channels;
  return wavFromPcm(Buffer.alloc(Math.round(durationSec * fmt.rate) * frameBytes), fmt);
}
