import { describe, expect, it, vi } from 'vitest';
import { createClientLogger, MAX_BUFFER } from '../src/lib/logger';

describe('client logger', () => {
  it('records level, scope, ts and meta in the ring buffer', () => {
    const log = createClientLogger();
    log.child('jobs').info('job started', { jobId: 'j1' });
    const [entry] = log.getLogs();
    expect(entry).toMatchObject({
      level: 'info',
      scope: 'ui.jobs',
      message: 'job started',
      meta: { jobId: 'j1' },
    });
    expect(new Date(entry.at).toString()).not.toBe('Invalid Date');
  });

  it('keeps at most MAX_BUFFER entries (oldest dropped first)', () => {
    const log = createClientLogger({ level: 'debug' });
    for (let i = 0; i < MAX_BUFFER + 50; i++) log.debug(`entry ${i}`);
    const logs = log.getLogs();
    expect(logs).toHaveLength(MAX_BUFFER);
    expect(logs[0].message).toBe('entry 50');
    expect(logs[logs.length - 1].message).toBe(`entry ${MAX_BUFFER + 49}`);
  });

  it('routes each level to the matching console function', () => {
    const log = createClientLogger();
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.info('info line');
    log.warn('w');
    log.error('e');
    expect(spyLog).toHaveBeenCalledTimes(1); // only the info line
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyError).toHaveBeenCalledTimes(1);
    spyLog.mockRestore();
    spyWarn.mockRestore();
    spyError.mockRestore();
  });

  it('respects a raised minimum level', () => {
    const log = createClientLogger({ level: 'warn' });
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    expect(log.getLogs()).toHaveLength(1);
  });

  it('getLogs returns a copy that cannot mutate the buffer', () => {
    const log = createClientLogger();
    log.info('one');
    const snapshot = log.getLogs();
    snapshot.push({ at: 'x', level: 'info', scope: 'ui', message: 'injected' });
    expect(log.getLogs()).toHaveLength(1);
  });

  it('clearLogs empties the buffer', () => {
    const log = createClientLogger();
    log.info('a');
    log.clearLogs();
    expect(log.getLogs()).toHaveLength(0);
  });
});
