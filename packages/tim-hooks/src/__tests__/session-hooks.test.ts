import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { onSessionStop } from '../session-hooks.js';
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
      summarizer: { cli: 'claude', model: 'haiku' },
    });

    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, ctx] = spawn.mock.calls[0];
    expect(cmd).toContain('claude');
    expect(cmd).toContain('haiku');
    expect(ctx.sessionId).toBe('st');
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
