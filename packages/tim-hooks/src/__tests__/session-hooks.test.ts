import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  onSessionStop,
  buildSummarizerCommand,
  maybeSpawnSummarizer,
  maybeSpawnProjectSummary,
  buildProjectSummaryCommand,
} from '../session-hooks.js';
import { writeMarker } from '../marker.js';
import { TimStore, SessionManager } from 'tim-store';

const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');

describe('onSessionStop', () => {
  let dir: string;
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'stop-'));
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0003');
    await sessions.startProjectSession({
      sessionId: 'st',
      projectId: 'P0003',
      agentName: 'a',
      cwd: dir,
      harness: 't',
      batchSize: 2,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('spawns the summarizer when pending >= batch_size', async () => {
    await sessions.logExchange('st', [
      { role: 'user', content: 'q1' },
      { role: 'agent', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'agent', content: 'a2' },
    ]);
    writeMarker(dir, {
      project: 'P0003',
      session: 'st',
      exchanges: 0,
      batch_size: 2,
      batches_summarized: 0,
    });

    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, ctx] = spawn.mock.calls[0];
    expect(cmd).toContain('trap');
    expect(cmd).toContain('timeout');
    expect(cmd).toContain('.tim/summarizer.log');
    expect(ctx.sessionId).toBe('st');
  });

  it('buildSummarizerCommand uses EXIT trap and tim-summarizer path', () => {
    const cmd = buildSummarizerCommand('sid', '/tmp/lock', '/tmp/log', 120);
    expect(cmd).toContain('trap');
    expect(cmd).toContain('EXIT');
    expect(cmd).toContain('tim-summarizer');
    expect(cmd).toContain('timeout 120');
    expect(cmd).toContain('TIM_SESSION_ID');
  });

  it('maybeSpawnSummarizer with batchFull skips below-threshold', async () => {
    await sessions.logExchange('st', [{ role: 'user', content: 'only' }]);
    writeMarker(dir, {
      project: 'P0003',
      session: 'st',
      exchanges: 1,
      batch_size: 2,
      batches_summarized: 0,
    });
    const spawn = vi.fn();
    const res = await maybeSpawnSummarizer(store, dir, { spawn, batchFull: true });
    expect(res.spawned).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('does NOT spawn when pending < batch_size', async () => {
    await sessions.logExchange('st', [{ role: 'user', content: 'only one' }]);
    writeMarker(dir, {
      project: 'P0003',
      session: 'st',
      exchanges: 0,
      batch_size: 2,
      batches_summarized: 0,
    });
    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips silently when no marker is present', async () => {
    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(false);
    expect(res.reason).toBe('no-marker');
  });
});

describe('maybeSpawnProjectSummary', () => {
  let dir: string;
  let store: TimStore;
  let sessions: SessionManager;

  async function startSessions(projectId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await sessions.startProjectSession({
        sessionId: `${projectId}-s${i}`,
        projectId,
        agentName: 'a',
        cwd: dir,
        harness: 't',
        batchSize: 2,
      });
    }
  }

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'psum-'));
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('countSessionSummaries counts sessions under the project', async () => {
    await store.createProject('P0010');
    await startSessions('P0010', 3);
    expect(await store.countSessionSummaries('P0010')).toBe(3);
  });

  it('spawns project summarizer when count is a multiple of threshold', async () => {
    await store.createProject('P0011');
    await startSessions('P0011', 5);
    const spawn = vi.fn();
    const res = await maybeSpawnProjectSummary(store, dir, 'P0011', { spawn, threshold: 5 });
    expect(res.spawned).toBe(true);
    expect(res.count).toBe(5);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd] = spawn.mock.calls[0];
    expect(cmd).toContain('--project-summary');
    expect(cmd).toContain('P0011');
  });

  it('does not spawn below threshold multiple', async () => {
    await store.createProject('P0012');
    await startSessions('P0012', 3);
    const spawn = vi.fn();
    const res = await maybeSpawnProjectSummary(store, dir, 'P0012', { spawn, threshold: 5 });
    expect(res.spawned).toBe(false);
    expect(res.reason).toBe('below-threshold');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips when no sessions exist', async () => {
    await store.createProject('P0013');
    const spawn = vi.fn();
    const res = await maybeSpawnProjectSummary(store, dir, 'P0013', { spawn, threshold: 5 });
    expect(res.spawned).toBe(false);
    expect(res.reason).toBe('no-sessions');
  });

  it('skips when label is null', async () => {
    const spawn = vi.fn();
    const res = await maybeSpawnProjectSummary(store, dir, null, { spawn, threshold: 5 });
    expect(res.spawned).toBe(false);
    expect(res.reason).toBe('no-label');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('buildProjectSummaryCommand targets the summarizer in project-summary mode', () => {
    const cmd = buildProjectSummaryCommand('P0014', '/tmp/log', 120);
    expect(cmd).toContain('--project-summary');
    expect(cmd).toContain('P0014');
    expect(cmd).toContain('timeout 120');
    expect(cmd).toContain('tim-summarizer');
  });
});
