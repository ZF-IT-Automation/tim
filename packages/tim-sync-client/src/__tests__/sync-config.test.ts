import { describe, it, expect, afterEach, vi } from 'vitest';

const fsyncFds = vi.hoisted(() => [] as number[]);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    fsyncSync(fd: number) {
      fsyncFds.push(fd);
      return actual.fsyncSync(fd);
    },
  };
});

import { clearConfig, clearSyncConnection, saveConfig, loadConfig, saveSyncState, loadSyncState } from '../config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('sync config disconnect', () => {
  const origHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = origHome!;
  });

  it('clearSyncConnection removes sync.json and sync-state.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-cfg-'));
    process.env.HOME = tmp;
    saveConfig({
      serverUrl: 'http://localhost:3100',
      userId: 'u1',
      token: 't1',
      salt: 's',
      fileId: 'f1',
    });
    saveSyncState({ fileId: 'f1', cursor: '2026-07-07T10:00:00.000Z|1', lastPush: null, lastPull: null });
    expect(loadConfig()).not.toBeNull();
    expect(loadSyncState()).not.toBeNull();
    expect(clearSyncConnection()).toEqual({ config: true, state: true });
    expect(loadConfig()).toBeNull();
    expect(loadSyncState()).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('saveSyncState writes mode 0600 and fsyncs the file and directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-mode-'));
    process.env.HOME = tmp;
    fsyncFds.length = 0;
    try {
      saveSyncState({ fileId: 'f1', cursor: null, lastPush: null, lastPull: null });
      const file = path.join(tmp, '.tim', 'sync-state.json');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fsyncFds.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
