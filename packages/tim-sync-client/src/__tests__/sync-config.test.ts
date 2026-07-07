import { describe, it, expect, afterEach } from 'vitest';
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
});
