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

  it('falls back to inbox when phantom marker cannot be repaired', async () => {
    const dbPath = path.join(root, 'phantom.db');
    const fileStore = new TimStore(dbPath);
    writeMarker(root, {
      project: 'P0888',
      session: 'old',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
      version: 2,
    });
    vi.spyOn(checkpoint, 'getActiveProjectLabel').mockReturnValue(null);

    try {
      const { project } = await runSessionStart(fileStore, {
        sessionId: 'phantom-1',
        agentName: 'agent',
        cwd: root,
        harness: 'test',
      });
      expect(project?.metadata.label).toBe('P0000');
      const projects = await fileStore.listProjects();
      expect(projects.filter(p => p.label !== 'P0000')).toHaveLength(0);
    } finally {
      fileStore.close();
    }
  });

  it('repairs phantom marker via alias and rewrites .tim-project', async () => {
    const dbPath = path.join(root, 'repair.db');
    const fileStore = new TimStore(dbPath);
    const alias = path.basename(root).toLowerCase();
    await fileStore.createProject('P0063', { content: 'TIM', aliases: [alias] });
    writeMarker(root, {
      project: 'P0888',
      session: 'old',
      exchanges: 4,
      batch_size: 5,
      batches_summarized: 1,
      version: 2,
    });
    vi.spyOn(checkpoint, 'getActiveProjectLabel').mockReturnValue(null);

    try {
      const { project } = await runSessionStart(fileStore, {
        sessionId: 'repair-1',
        agentName: 'agent',
        cwd: root,
        harness: 'test',
      });
      expect(project?.metadata.label).toBe('P0063');
      const marker = JSON.parse(fs.readFileSync(path.join(root, '.tim-project'), 'utf8'));
      expect(marker.project).toBe('P0063');
    } finally {
      fileStore.close();
    }
  });
});
