import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (process.env.TIM_FAIL_PRIVATE_WRITE === '1' && typeof args[0] === 'number') {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      }
      return actual.writeFileSync(...args);
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWritePrivate } from '../private-file.js';
import { saveSyncState, SyncStateConflictError, type SyncState } from '../config.js';

describe('private sync files', () => {
  it('replaces an existing file with mode 0600 and directory 0700', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-private-'));
    const target = path.join(dir, 'sync-state.json');
    fs.writeFileSync(target, 'old', { mode: 0o644 });
    fs.chmodSync(dir, 0o755);
    try {
      atomicWritePrivate(target, 'new');
      expect(fs.readFileSync(target, 'utf8')).toBe('new');
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous file when the temporary write fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-enospc-'));
    const target = path.join(dir, 'queue.json');
    fs.writeFileSync(target, 'durable', { mode: 0o644 });
    process.env.TIM_FAIL_PRIVATE_WRITE = '1';
    try {
      expect(() => atomicWritePrivate(target, 'replacement')).toThrow(/no space/);
      expect(fs.readFileSync(target, 'utf8')).toBe('durable');
      expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
    } finally {
      delete process.env.TIM_FAIL_PRIVATE_WRITE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to move the cursor backwards from a stale epoch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-epoch-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const state: SyncState = {
        fileId: 'f1',
        cursor: 'gen|1',
        lastPush: null,
        lastPull: null,
      };
      saveSyncState(state);
      expect(state.stateEpoch).toBe(1);
      const stale = { ...state, cursor: 'gen|1', stateEpoch: 1 };
      saveSyncState({ ...state, cursor: 'gen|2' });
      expect(() => saveSyncState({ ...stale, cursor: null })).toThrow(SyncStateConflictError);
      const saved = JSON.parse(fs.readFileSync(path.join(home, '.tim', 'sync-state.json'), 'utf8')) as {
        cursor: string;
        stateEpoch: number;
      };
      expect(saved.cursor).toBe('gen|2');
      expect(saved.stateEpoch).toBe(2);
      expect(fs.statSync(path.join(home, '.tim')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(home, '.tim', 'sync-state.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.env.HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
