import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, SessionManager } from 'tim-store';
import { rebalanceBatch } from '../rebalance.js';
import { MARKER_LOCK, writeMarker } from '../marker.js';

let store: TimStore;
let sessions: SessionManager;
let tmpDir: string;

beforeEach(async () => {
  store = new TimStore(':memory:');
  sessions = new SessionManager(store);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-rebalance-'));
  await store.createProject('P0099');
  await sessions.startProjectSession({
    sessionId: 'rebal-sess',
    projectId: 'P0099',
    agentName: 'test',
    cwd: tmpDir,
    harness: 'vitest',
    batchSize: 2,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function logPair(user: string, agent: string) {
  await sessions.logExchange('rebal-sess', [
    { role: 'user', content: user },
    { role: 'agent', content: agent },
  ]);
}

describe('rebalanceBatch', () => {
  it('moves first exchange of batch N into N-1 when boundary topics overlap', async () => {
    await logPair('typescript auth login flow', 'ok login');
    await logPair('typescript auth token refresh', 'refreshed');
    await logPair('typescript auth logout cleanup', 'done logout');
    await logPair('unrelated cooking pasta recipe', 'enjoy pasta');

    const before = await rebalanceBatch(store, 'rebal-sess', { cwd: tmpDir });
    expect(before.moved).toBe(1);

    const exNode = (await store.getChildByKind('rebal-sess', 'exchanges-root'))[0]!;
    const batches = await store.getChildByKind(exNode.id, 'exchange-batch');
    const b1Users = (await store.getChildrenBySeq(batches[0]!.id)).filter(
      u => u.metadata.role === 'user',
    );
    const b2Users = (await store.getChildrenBySeq(batches[1]!.id)).filter(
      u => u.metadata.role === 'user',
    );
    expect(b1Users.map(u => u.title)).toContain('typescript auth logout cleanup');
    expect(b2Users.map(u => u.title)).toEqual(['unrelated cooking pasta recipe']);
  });

  it('skips when boundary exchanges share no keywords', async () => {
    await logPair('alpha database schema', 'ok schema');
    await logPair('beta database migration', 'migrated');
    await logPair('gamma cooking pasta', 'pasta done');
    await logPair('delta astronomy stars', 'stars noted');

    const result = await rebalanceBatch(store, 'rebal-sess', { cwd: tmpDir });
    expect(result.moved).toBe(0);
    expect(result.skipped.some(s => s.reason === 'unrelated')).toBe(true);
  });

  it('never splits a batch that has only one user exchange', async () => {
    await logPair('solo typescript topic', 'solo reply');
    await logPair('typescript auth part two', 'part two');
    await logPair('typescript auth part three', 'part three');

    const exNode = (await store.getChildByKind('rebal-sess', 'exchanges-root'))[0]!;
    let batches = await store.getChildByKind(exNode.id, 'exchange-batch');
    const lastBatch = batches[batches.length - 1]!;
    const users = (await store.getChildrenBySeq(lastBatch.id)).filter(
      u => u.metadata.role === 'user',
    );
    expect(users).toHaveLength(1);

    const result = await rebalanceBatch(store, 'rebal-sess', { cwd: tmpDir });
    expect(result.moved).toBe(0);
    expect(result.skipped.some(s => s.reason === 'single-exchange-batch')).toBe(true);
  });

  it('skips when session lock is active', async () => {
    writeMarker(tmpDir, {
      project: 'P0099',
      session: 'rebal-sess',
      exchanges: 0,
      batch_size: 2,
      batches_summarized: 0,
    });
    fs.writeFileSync(
      path.join(tmpDir, MARKER_LOCK),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );

    await logPair('typescript auth one', 'one');
    await logPair('typescript auth two', 'two');
    await logPair('typescript auth three', 'three');
    await logPair('typescript auth four', 'four');

    const result = await rebalanceBatch(store, 'rebal-sess', { cwd: tmpDir });
    expect(result.moved).toBe(0);
    expect(result.skipped).toEqual([{ reason: 'locked' }]);
  });
});
