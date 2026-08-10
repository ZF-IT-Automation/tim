import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, ensureProjectForPath } from '../index.js';

// ensureProjectForPath refuses to auto-create under /tmp, and $HOME itself is
// /tmp/… whenever the suite runs with a scratch HOME. So the fixture lives in
// the repo's gitignored tmp/ instead of on the developer's machine.
const TEST_ROOT = path.resolve(import.meta.dirname, '../../../../tmp');

describe('ensureProjectForPath', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'tim-test-auto-project-'));
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
    // Path-only rule — the directory need not exist, so nothing is created in $HOME.
    const taskDir = path.join(os.homedir(), 'projects', 'tasks', 'task-x');
    expect(await ensureProjectForPath(store, taskDir)).toBeNull();
  });

  it('rebinds to existing project by directory alias without creating a new label', async () => {
    const projectDir = path.join(dir, 'tim');
    fs.mkdirSync(projectDir);
    await store.createProject('P0063', {
      content: 'TIM | Active',
      aliases: ['tim'],
    });

    const result = await ensureProjectForPath(store, projectDir);
    expect(result).toMatchObject({ label: 'P0063', created: false });
    const projects = await store.listProjects();
    expect(projects.filter(p => p.label.startsWith('P01'))).toHaveLength(0);
  });

  it('assigns unique labels for sequential creation', async () => {
    const dirs = Array.from({ length: 4 }, (_, i) => {
      const d = path.join(dir, `seq-${i}`);
      fs.mkdirSync(d);
      return d;
    });
    const labels: string[] = [];
    for (const d of dirs) {
      const result = await ensureProjectForPath(store, d);
      labels.push(result!.label);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });
});
