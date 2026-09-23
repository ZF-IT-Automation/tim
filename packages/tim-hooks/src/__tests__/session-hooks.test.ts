import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  onSessionStop,
  buildSummarizerSpawnRequest,
  isSummarizerChild,
  maybeSpawnSummarizer,
  maybeSpawnProjectSummary,
  buildProjectSummarySpawnRequest,
} from '../session-hooks.js';
import { writeMarker, summarizerLockPath } from '../marker.js';
import { TimStore, SessionManager } from 'tim-store';

const TEST_ROOT = path.join(os.tmpdir(), 'tim-test-runs');

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
    writeMarker(dir, { project: 'P0003' });

    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const [req] = spawn.mock.calls[0];
    expect(req.sessionId).toBe('st');
    expect(req.cwd).toBe(dir);
    expect(req.lockPath).toBe(summarizerLockPath(dir));
    expect(req.logPath).toContain('.tim/summarizer.log');
  });

  it('maybeSpawnSummarizer honors an explicit sessionId option', async () => {
    await sessions.logExchange('st', [
      { role: 'user', content: 'q1' },
      { role: 'agent', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'agent', content: 'a2' },
    ]);
    writeMarker(dir, { project: 'P0003' });
    const spawn = vi.fn();
    const res = await maybeSpawnSummarizer(store, dir, { spawn, sessionId: 'st' });
    expect(res.spawned).toBe(true);
    expect(spawn.mock.calls[0][0].sessionId).toBe('st');
  });

  it('maybeSpawnSummarizer resolves session via store when sessionId omitted', async () => {
    await sessions.logExchange('st', [
      { role: 'user', content: 'q1' },
      { role: 'agent', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'agent', content: 'a2' },
    ]);
    writeMarker(dir, { project: 'P0003' });
    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(true);
    expect(spawn.mock.calls[0][0].sessionId).toBe('st');
  });

  it('buildSummarizerSpawnRequest carries session, paths and timeout', () => {
    const req = buildSummarizerSpawnRequest('sid', dir, summarizerLockPath(dir), '/tmp/log', 120);
    expect(req.sessionId).toBe('sid');
    expect(req.cwd).toBe(dir);
    expect(req.timeoutSec).toBe(120);
    expect(req.lockPath).toBe(summarizerLockPath(dir));
    expect(req.logPath).toBe('/tmp/log');
  });

  it('isSummarizerChild only fires on the exact flag value', () => {
    expect(isSummarizerChild({ TIM_SUMMARIZER: '1' })).toBe(true);
    expect(isSummarizerChild({})).toBe(false);
    expect(isSummarizerChild({ TIM_SUMMARIZER: '' })).toBe(false);
  });

  it('isTeamupWorker only fires on the exact flag value', async () => {
    const { isTeamupWorker } = await import('../session-hooks.js');
    expect(isTeamupWorker({ TEAMUP_WORKER: '1' })).toBe(true);
    expect(isTeamupWorker({})).toBe(false);
    expect(isTeamupWorker({ TEAMUP_WORKER: '' })).toBe(false);
  });

  it('maybeSpawnSummarizer with batchFull skips below-threshold', async () => {
    await sessions.logExchange('st', [{ role: 'user', content: 'only' }]);
    writeMarker(dir, { project: 'P0003' });
    const spawn = vi.fn();
    const res = await maybeSpawnSummarizer(store, dir, { spawn, batchFull: true });
    expect(res.spawned).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('does NOT spawn when pending < batch_size', async () => {
    await sessions.logExchange('st', [{ role: 'user', content: 'only one' }]);
    writeMarker(dir, { project: 'P0003' });
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
    const [req] = spawn.mock.calls[0];
    expect(req.projectSummaryLabel).toBe('P0011');
    expect(req.sessionId).toBe('P0011');
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

  it('buildProjectSummarySpawnRequest targets project-summary mode', () => {
    const req = buildProjectSummarySpawnRequest('P0014', dir, '/tmp/log', 120);
    expect(req.projectSummaryLabel).toBe('P0014');
    expect(req.sessionId).toBe('P0014');
    expect(req.timeoutSec).toBe(120);
    expect(req.logPath).toBe('/tmp/log');
  });
});
