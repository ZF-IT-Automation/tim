import { describe, it, expect, vi } from 'vitest';
import {
  isBrokenPipeError,
  handleUncaughtException,
  handleStdioStreamError,
} from '../process-error-guards.js';

describe('isBrokenPipeError', () => {
  it('recognizes EPIPE, ECONNRESET, and destroyed streams', () => {
    expect(isBrokenPipeError({ code: 'EPIPE', message: 'write EPIPE' })).toBe(true);
    expect(isBrokenPipeError({ code: 'ECONNRESET' })).toBe(true);
    expect(isBrokenPipeError({ code: 'ERR_STREAM_DESTROYED' })).toBe(true);
  });

  it('lets other errors through', () => {
    expect(isBrokenPipeError(new Error('boom'))).toBe(false);
    expect(isBrokenPipeError({ code: 'ENOENT' })).toBe(false);
  });
});

describe('handleUncaughtException', () => {
  it('exits immediately on EPIPE and does not write the error log', () => {
    const log = vi.fn();
    const exit = vi.fn();
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    handleUncaughtException(err, log, exit);

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs non-pipe uncaught exceptions and stays alive', () => {
    const log = vi.fn();
    const exit = vi.fn();
    const err = new Error('unexpected');

    handleUncaughtException(err, log, exit);

    expect(log).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('handleStdioStreamError', () => {
  it('exits on EPIPE without logging to the database', () => {
    const exit = vi.fn();
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    handleStdioStreamError(err, exit);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('handleStdioStreamError exits stderr EPIPE the same as stdout', () => {
    const exit = vi.fn();
    handleStdioStreamError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), exit);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not exit on unrelated stream errors', () => {
    const exit = vi.fn();
    handleStdioStreamError(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), exit);
    expect(exit).not.toHaveBeenCalled();
  });
});
