import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Shared-token guard for state-changing routes (PATCH/POST/PUT/DELETE).
 * Read-only (GET/HEAD/OPTIONS) requests always pass, so a public read-only mirror
 * is still possible. When `token` is empty it is a no-op (local single-user use).
 *
 * Accepts `Authorization: Bearer <token>` or an `x-api-token: <token>` header.
 * Comparison is constant-time (timingSafeEqual) to avoid a length/byte oracle.
 */
export function makeTokenAuth(token?: string) {
  const required = (token ?? '').trim();
  if (!required) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!MUTATING.has(req.method)) {
      next();
      return;
    }
    const header = req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const raw = bearer || (req.header('x-api-token') ?? '').trim();
    if (raw && tokensEqual(raw, required)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
    return;
  };
}
