import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import * as checkpoint from '../checkpoint.js';
import { runSessionStart } from '../checkpoint.js';
import { writeMarker } from '../marker.js';

describe('auto-project on session start', () => {
  let store: TimStore;
  let root: string;

  beforeEach(() => {
    store = new TimStore(':memory:');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-auto-proj-'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates project from directory name when no marker exists', async () => {
    const base = path.join(os.homedir(), '.tim-test-session');
    const sub = path.join(base, 'my-widget');
    fs.mkdirSync(sub, { recursive: true });
    vi.spyOn(checkpoint, 'getActiveProjectLabel').mockReturnValue(null);

    try {
      const { project } = await runSessionStart(store, {
        sessionId: 'auto-1',
        agentName: 'agent',
        cwd: sub,
        harness: 'test',
      });
      expect(project?.metadata.label).toMatch(/^P\d{4}$/);
      expect(project?.metadata.auto_created).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps existing marker project unchanged', async () => {
    await store.createProject('P0042', { content: 'Existing', aliases: ['existing'] });
    writeMarker(root, { project: 'P0042', session: 'old', exchanges: 0, batch_size: 5, batches_summarized: 0, version: 2 });
    const { project } = await runSessionStart(store, { sessionId: 'bound-1', agentName: 'agent', cwd: root, harness: 'test' });
    expect(project?.metadata.label).toBe('P0042');
  });
});
