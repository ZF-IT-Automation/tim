import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runCheckpointWithSummarizerSpawn } from '../checkpoint.js';
import { maybeSpawnSummarizer } from '../session-hooks.js';
import { writeMarker } from '../marker.js';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
} from 'tim-store';

describe('checkpoint spawns summarizer (criteria 14–15)', () => {
  let dir: string;
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-checkpoint-spawn-'));
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0063');
    writeMarker(dir, { project: 'P0063' });
    await sessions.startProjectSession({
      sessionId: 'sess-cp',
      projectId: 'P0063',
      agentName: 'test',
      cwd: dir,
      harness: 'codex',
      batchSize: 5,
    });
    await sessions.logExchange('sess-cp', [
      { role: 'user', content: 'hello' },
      { role: 'agent', content: 'hi' },
    ]);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('criterion 14: spawns exactly once with batchFull and explicit session id', async () => {
    const spawn = vi.fn();
    await runCheckpointWithSummarizerSpawn(store, 'sess-cp', dir, { spawn });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toMatchObject({ sessionId: 'sess-cp', cwd: dir });
  });

  it('criterion 14: batchFull skips below-threshold pending gate', async () => {
    const spawn = vi.fn();
    const res = await maybeSpawnSummarizer(store, dir, { spawn });
    expect(res).toMatchObject({ spawned: false, reason: 'below-threshold' });
    expect(spawn).not.toHaveBeenCalled();

    const spawn2 = vi.fn();
    await runCheckpointWithSummarizerSpawn(store, 'sess-cp', dir, { spawn: spawn2 });
    expect(spawn2).toHaveBeenCalledOnce();
  });

  it('criterion 15: handoff note survives rollup when spawn runs after checkpoint', async () => {
    let noteAtSpawn: string | undefined;
    const spawn = vi.fn(async (_cmd, ctx) => {
      const root = await findChildByKind(store, ctx.sessionId, KIND_SUMMARY_ROOT);
      noteAtSpawn = root?.metadata.handoff_note as string | undefined;
      await sessions.updateSessionSummary(ctx.sessionId, 'rollup from spawned summarizer');
    });
    await runCheckpointWithSummarizerSpawn(store, 'sess-cp', dir, {
      handoffNote: 'done: ship | next: verify',
      spawn,
    });
    expect(noteAtSpawn).toBe('done: ship | next: verify');
    const root = await findChildByKind(store, 'sess-cp', KIND_SUMMARY_ROOT);
    expect(root?.metadata.handoff_note).toBe('done: ship | next: verify');
  });
});
