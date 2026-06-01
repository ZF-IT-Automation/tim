import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { onSessionStop, buildSummarizerCommand, maybeSpawnSummarizer } from '../session-hooks.js';
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
