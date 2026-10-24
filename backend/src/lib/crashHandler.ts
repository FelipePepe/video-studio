import type { Logger } from './logger';

/**
 * Creates a process-level `uncaughtException` handler.
 *
 * An exception that reaches this point is unrecoverable (the classic B1 class: an unhandled
 * 'error' event firing from a stream that was not being listened to — e.g. a mid-download
 * network/disk failure in the ComfyUI download path). Logging it and exiting cleanly is better
 * than letting Node crash with an opaque traceback, or worse, keeping a corrupt process alive.
 * (The actual crash source is fixed at the site — comfy.ts download — so this should rarely fire.)
 */
export function makeCrashHandler(log: Pick<Logger, 'error'>): (err: unknown) => void {
  return (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('uncaughtException — exiting (unhandled async exception)', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  };
}
