import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, ensureProjectForPath } from '../index.js';

describe('ensureProjectForPath', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.homedir(), '.tim-test-auto-project-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null for home, /tmp, and task directories', async () => {
    expect(await ensureProjectForPath(store, os.homedir())).toBeNull();
    expect(await ensureProjectForPath(store, '/tmp/foo')).toBeNull();
    const taskDir = path.join(os.homedir(), 'projects', 'tasks', 'task-x');
    fs.mkdirSync(taskDir, { recursive: true });
    expect(await ensureProjectForPath(store, taskDir)).toBeNull();
  });

  it('assigns unique labels under parallel creation', async () => {
    const dirs = Array.from({ length: 4 }, (_, i) => {
      const d = path.join(dir, `parallel-${i}`);
      fs.mkdirSync(d);
      return d;
    });
    const results = await Promise.all(dirs.map(d => ensureProjectForPath(store, d)));
    const labels = results.map(r => r?.label).filter(Boolean);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
