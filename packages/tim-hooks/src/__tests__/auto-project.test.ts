import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { runSessionStart } from '../checkpoint.js';
import { writeMarker } from '../marker.js';

describe('auto-project on session start', () => {
  let store: TimStore;
  let root: string;

  beforeEach(() => {
    store = new TimStore(':memory:');
    // Under $HOME but not $HOME itself — /tmp is blocked by ensureProjectForPath
    root = fs.mkdtempSync(path.join(os.homedir(), '.tim-auto-proj-'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates project from directory name when no marker exists', async () => {
    const sub = path.join(root, 'my-widget');
    fs.mkdirSync(sub, { recursive: true });

    const { project } = await runSessionStart(store, {
      sessionId: 'auto-1',
      agentName: 'agent',
      cwd: sub,
      harness: 'test',
    });

    expect(project?.metadata.label).toMatch(/^P\d{4}$/);
    expect(project?.metadata.auto_created).toBe(true);
    const resolved = await store.resolveProjectLabel('my-widget');
    expect(resolved.status).toBe('found');
  });

  it('keeps existing marker project unchanged', async () => {
    await store.createProject('P0042', { content: 'Existing', aliases: ['existing'] });
    writeMarker(root, {
      project: 'P0042',
      session: 'old',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
      version: 2,
    });

    const { project } = await runSessionStart(store, {
      sessionId: 'bound-1',
      agentName: 'agent',
      cwd: root,
      harness: 'test',
    });

    expect(project?.metadata.label).toBe('P0042');
    const projects = await store.listProjects();
    expect(projects.filter(p => p.label !== 'P0000').length).toBe(1);
  });
});
