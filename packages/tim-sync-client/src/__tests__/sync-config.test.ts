import { describe, it, expect, afterEach } from 'vitest';
import { clearConfig, saveConfig, loadConfig } from '../config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('sync config disconnect', () => {
  const origHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = origHome!;
  });

  it('clearConfig removes sync.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-cfg-'));
    process.env.HOME = tmp;
    saveConfig({
      serverUrl: 'http://localhost:3100',
      userId: 'u1',
      token: 't1',
      salt: 's',
      fileId: 'f1',
    });
    expect(loadConfig()).not.toBeNull();
    expect(clearConfig()).toBe(true);
    expect(loadConfig()).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
