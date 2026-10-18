export interface PiperTarget {
  host: string;
  port: number;
}

export function parsePiperHost(value: string): PiperTarget | null {
  const m = /^tcp:\/\/([^/:\s]+):(\d{1,5})$/.exec(value);
  if (!m) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}
