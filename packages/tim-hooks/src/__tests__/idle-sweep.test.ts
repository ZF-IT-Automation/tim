import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sweepIdleSessions } from '../session-hooks.js';
import { writeMarker, releaseLock } from '../marker.js';
import { runCheckpointWithSummarizerSpawn, runSessionEnd } from '../checkpoint.js';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
} from 'tim-store';

const TEST_ROOT = path.join(os.tmpdir(), 'tim-idle-sweep');

function backdateSessionExchanges(store: TimStore, sessionId: string, iso: string): void {
  const db = store.getDb();
  db.prepare(`
    UPDATE entries SET created_at = ?, updated_at = ?
    WHERE id IN (
      WITH RECURSIVE sub AS (
        SELECT id FROM entries WHERE parent_id = ?
        UNION ALL
        SELECT e.id FROM entries e INNER JOIN sub ON e.parent_id = sub.id
      )
      SELECT id FROM sub
      UNION SELECT id FROM entries WHERE id = ?
    )
  `).run(iso, iso, sessionId, sessionId);
}

async function startSession(
  sessions: SessionManager,
  store: TimStore,
  opts: {
    sessionId: string;
    projectId: string;
    cwd: string;
    batchSize?: number;
    exchanges?: number;
    backdateTo?: string;
  },
): Promise<void> {
  const { sessionId, projectId, cwd, batchSize = 2, exchanges = 2, backdateTo } = opts;
  await sessions.startProjectSession({
    sessionId,
    projectId,
    agentName: 'test',
    cwd,
    harness: 'codex',
    batchSize,
  });
  const turns: Array<{ role: 'user' | 'agent'; content: string }> = [];
  for (let i = 0; i < exchanges; i++) {
    turns.push({ role: 'user', content: `q${i}` });
    turns.push({ role: 'agent', content: `a${i}` });
  }
  if (turns.length) await sessions.logExchange(sessionId, turns);
  if (backdateTo) backdateSessionExchanges(store, sessionId, backdateTo);
}

describe('sweepIdleSessions (criteria 5–9, 13)', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0100');
  });

  afterEach(() => {
    store.close();
  });

  it('criterion 5–8: spawns only for idle session with valid cwd and marker', async () => {
    const idleDir = fs.mkdtempSync(path.join(TEST_ROOT, 'idle-'));
    const freshDir = fs.mkdtempSync(path.join(TEST_ROOT, 'fresh-'));
    const noMarkerDir = fs.mkdtempSync(path.join(TEST_ROOT, 'nomarker-'));
    const missingDir = path.join(TEST_ROOT, 'gone-dir');

    writeMarker(idleDir, { project: 'P0100' });
    writeMarker(freshDir, { project: 'P0100' });

    const old = '2026-01-01T10:00:00.000Z';
    const recent = '2026-08-12T16:10:00.000Z';
    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();

    await startSession(sessions, store, {
      sessionId: 'idle-s',
      projectId: 'P0100',
      cwd: idleDir,
      backdateTo: old,
    });
    await startSession(sessions, store, {
      sessionId: 'fresh-s',
      projectId: 'P0100',
      cwd: freshDir,
      backdateTo: recent,
    });
    await startSession(sessions, store, {
      sessionId: 'nomarker-s',
      projectId: 'P0100',
      cwd: noMarkerDir,
      backdateTo: old,
    });
    await startSession(sessions, store, {
      sessionId: 'missing-s',
      projectId: 'P0100',
      cwd: missingDir,
      backdateTo: old,
    });

    const spawn = vi.fn();
    const results = await sweepIdleSessions(store, { spawn, now, idleMinutes: 15 });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toMatchObject({ sessionId: 'idle-s', cwd: idleDir });

    const spawned = results.filter(r => r.reason === 'spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.sessionId).toBe('idle-s');

    const errors = store.getDb().prepare(
      `SELECT error FROM error_log WHERE tool = 'idle_sweep'`,
    ).all() as Array<{ error: string }>;
    expect(errors).toHaveLength(2);
    expect(errors.some(e => e.error.includes('does not exist'))).toBe(true);
    expect(errors.some(e => e.error.includes('no .tim-project'))).toBe(true);
  });

  it('criterion 9: caps spawns at maxSpawnsPerPass across distinct cwds', async () => {
    const dirs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = fs.mkdtempSync(path.join(TEST_ROOT, `cap-${i}-`));
      writeMarker(d, { project: 'P0100' });
      dirs.push(d);
      await startSession(sessions, store, {
        sessionId: `cap-s${i}`,
        projectId: 'P0100',
        cwd: d,
        backdateTo: '2026-01-01T10:00:00.000Z',
      });
    }

    const spawn = vi.fn();
    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();
    await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxSpawnsPerPass: 3 });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('criterion 9: same cwd yields one spawn and one locked per pass', async () => {
    const sharedDir = fs.mkdtempSync(path.join(TEST_ROOT, 'shared-'));
    writeMarker(sharedDir, { project: 'P0100' });
    const old = '2026-01-01T10:00:00.000Z';
    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();

    await startSession(sessions, store, {
      sessionId: 'lock-a',
      projectId: 'P0100',
      cwd: sharedDir,
      backdateTo: old,
    });
    await startSession(sessions, store, {
      sessionId: 'lock-b',
      projectId: 'P0100',
      cwd: sharedDir,
      backdateTo: old,
    });

    const spawn = vi.fn();
    const first = await sweepIdleSessions(store, { spawn, now, idleMinutes: 15 });
    expect(spawn).toHaveBeenCalledOnce();
    const reasons = first.map(r => r.reason);
    expect(reasons).toContain('spawned');
    expect(reasons).toContain('locked');

    releaseLock(sharedDir);
    const spawn2 = vi.fn();
    await sweepIdleSessions(store, { spawn: spawn2, now, idleMinutes: 15 });
    expect(spawn2).toHaveBeenCalledOnce();
  });

  it('criterion 13: sweep spawn does not write checkpoint or change handoff note', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'c13-'));
    writeMarker(dir, { project: 'P0100' });
    await startSession(sessions, store, {
      sessionId: 'c13-s',
      projectId: 'P0100',
      cwd: dir,
      backdateTo: '2026-01-01T10:00:00.000Z',
    });

    const summaryRoot = await findChildByKind(store, 'c13-s', KIND_SUMMARY_ROOT);
    if (summaryRoot) {
      await store.update(summaryRoot.id, {
        metadata: { ...summaryRoot.metadata, handoff_note: 'keep-me' },
      });
    }

    const projectBefore = await store.read('P0100');
    const spawn = vi.fn();
    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();
    await sweepIdleSessions(store, { spawn, now, idleMinutes: 15 });

    const checkpoints = store.getDb().prepare(
      `SELECT id FROM entries WHERE json_extract(metadata, '$.kind') = 'checkpoint'`,
    ).all();
    expect(checkpoints).toHaveLength(0);

    const rootAfter = await findChildByKind(store, 'c13-s', KIND_SUMMARY_ROOT);
    expect(rootAfter?.metadata.handoff_note).toBe('keep-me');

    const projectAfter = await store.read('P0100');
    expect(projectAfter?.content).toBe(projectBefore?.content);
  });
});

describe('sweepIdleSessions (criterion 10 — attempt cap)', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0100');
  });

  afterEach(() => {
    store.close();
  });

  it('retries three times then skips with one error-log entry', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'c10-'));
    writeMarker(dir, { project: 'P0100' });
    await startSession(sessions, store, {
      sessionId: 'strike-s',
      projectId: 'P0100',
      cwd: dir,
      backdateTo: '2026-01-01T10:00:00.000Z',
    });

    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();
    const spawn = vi.fn();

    for (let pass = 0; pass < 3; pass++) {
      releaseLock(dir);
      await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxAttempts: 3 });
    }
    expect(spawn).toHaveBeenCalledTimes(3);

    releaseLock(dir);
    const fourth = await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxAttempts: 3 });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(fourth.some(r => r.sessionId === 'strike-s' && r.reason === 'exhausted')).toBe(true);

    const exhaustedErrors = store.getDb().prepare(
      `SELECT error, session_id FROM error_log WHERE tool = 'idle_sweep' AND error LIKE '%exhausted%'`,
    ).all() as Array<{ error: string; session_id: string }>;
    expect(exhaustedErrors).toHaveLength(1);
    expect(exhaustedErrors[0]!.session_id).toBe('strike-s');

    releaseLock(dir);
    await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxAttempts: 3 });
    const exhaustedAgain = store.getDb().prepare(
      `SELECT error FROM error_log WHERE tool = 'idle_sweep' AND error LIKE '%exhausted%'`,
    ).all();
    expect(exhaustedAgain).toHaveLength(1);
  });

  it('resets the counter when a summary is written', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'c10-reset-'));
    writeMarker(dir, { project: 'P0100' });
    await startSession(sessions, store, {
      sessionId: 'reset-s',
      projectId: 'P0100',
      cwd: dir,
      batchSize: 2,
      exchanges: 4,
      backdateTo: '2026-01-01T10:00:00.000Z',
    });

    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();
    const spawn = vi.fn();

    releaseLock(dir);
    await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxAttempts: 3 });
    expect(spawn).toHaveBeenCalledTimes(1);

    releaseLock(dir);
    await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxAttempts: 3 });
    expect(spawn).toHaveBeenCalledTimes(2);

    let session = await store.read('reset-s');
    expect(session?.metadata.sweep_attempts).toBe(1);

    await sessions.writeBatchSummary('reset-s', 1, 'recovered', { seqFrom: 1, seqTo: 2 });

    releaseLock(dir);
    await sweepIdleSessions(store, { spawn, now, idleMinutes: 15, maxAttempts: 3 });
    expect(spawn).toHaveBeenCalledTimes(3);

    session = await store.read('reset-s');
    expect(session?.metadata.sweep_attempts ?? 0).toBe(0);
    expect(session?.metadata.sweep_batches_at_spawn).toBe(1);
  });

  it('session end and checkpoint still spawn after sweep gives up', async () => {
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'c10-hooks-'));
    writeMarker(dir, { project: 'P0100' });
    await startSession(sessions, store, {
      sessionId: 'hooks-s',
      projectId: 'P0100',
      cwd: dir,
      batchSize: 5,
      exchanges: 2,
      backdateTo: '2026-01-01T10:00:00.000Z',
    });

    const now = () => new Date('2026-08-12T16:20:00.000Z').getTime();
    const sweepSpawn = vi.fn();
    for (let pass = 0; pass < 3; pass++) {
      releaseLock(dir);
      await sweepIdleSessions(store, {
        spawn: sweepSpawn,
        now,
        idleMinutes: 15,
        maxAttempts: 3,
      });
    }
    releaseLock(dir);
    await sweepIdleSessions(store, {
      spawn: sweepSpawn,
      now,
      idleMinutes: 15,
      maxAttempts: 3,
    });
    expect(sweepSpawn).toHaveBeenCalledTimes(3);

    const endSpawn = vi.fn();
    releaseLock(dir);
    await runSessionEnd(store, 'hooks-s', { env: { TIM_CWD: dir }, spawn: endSpawn });
    expect(endSpawn).toHaveBeenCalledOnce();

    const checkpointSpawn = vi.fn();
    releaseLock(dir);
    await runCheckpointWithSummarizerSpawn(store, 'hooks-s', dir, { spawn: checkpointSpawn });
    expect(checkpointSpawn).toHaveBeenCalledOnce();
  });
});
