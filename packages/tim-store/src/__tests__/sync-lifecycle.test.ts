import { describe, it, expect, afterEach } from 'vitest';
import type { Entry, StagingRecord } from 'tim-core';
import { TimStore, SessionManager } from '../index.js';
import { getUnackedStaging, ackStaging } from '../sync-methods.js';

async function collectDescendants(store: TimStore, rootId: string): Promise<Entry[]> {
  const result: Entry[] = [];
  async function walk(parentId: string): Promise<void> {
    const children = await store.getChildren(parentId);
    for (const child of children) {
      result.push(child);
      await walk(child.id);
    }
  }
  await walk(rootId);
  return result;
}

describe('sync lifecycle (F-STORE-002/004/005)', () => {
  let store: TimStore;

  afterEach(() => {
    store?.close();
  });

  it('soft delete stages with irrelevant=1 (F-STORE-002)', async () => {
    store = new TimStore(':memory:');
    const entry = await store.write('hello world');
    ackStaging(store.getDb(), [entry.id]);
    await store.delete(entry.id, false);
    const unacked = getUnackedStaging(store.getDb());
    expect(unacked).toHaveLength(1);
    const payload = JSON.parse(unacked[0]!.payload) as { id: string; irrelevant: number };
    expect(payload.id).toBe(entry.id);
    expect(payload.irrelevant).toBe(1);
  });

  it('applyStaging with older timestamp is rejected (F-STORE-004)', async () => {
    store = new TimStore(':memory:');
    const entry = await store.write('title\noriginal');
    const row = store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(entry.id) as Record<
      string,
      unknown
    >;
    store.getDb().prepare("UPDATE entries SET accessed_at = '2099-01-01T00:00:00Z' WHERE id = ?").run(
      entry.id,
    );
    const remote: StagingRecord = {
      key: entry.id,
      entityType: 'entry',
      operation: 'upsert',
      payload: JSON.stringify({
        ...row,
        content: 'STALE OVERWRITE',
        accessed_at: '2000-01-01T00:00:00Z',
        created_at: '2000-01-01T00:00:00Z',
      }),
      lwwTimestamp: Date.parse('2000-01-01T00:00:00Z'),
      lwwDevice: 'remote',
      lwwConfidence: 1.0,
      acked: false,
    };
    await store.applyStaging([remote]);
    const after = await store.read(entry.id);
    expect(after?.content).toBe('original');
  });

  it('concurrent logExchange produces monotonic seq + unique batch_index (F-STORE-005)', async () => {
    store = new TimStore(':memory:');
    const sessions = new SessionManager(store);
    await store.createProject('P0099');
    await sessions.startProjectSession({
      sessionId: 'sess-conc-1',
      projectId: 'P0099',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });

    const userMsg = (i: number) => ({ role: 'user' as const, content: `u${i}` });
    await Promise.all([
      sessions.logExchange('sess-conc-1', [userMsg(1), userMsg(2), userMsg(3)]),
      sessions.logExchange('sess-conc-1', [userMsg(4), userMsg(5), userMsg(6)]),
    ]);

    const all = await collectDescendants(store, 'sess-conc-1');
    const userExchanges = all.filter(
      e => e.metadata.kind === 'exchange' && e.metadata.role === 'user',
    );
    const seqs = userExchanges.map(e => e.metadata.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    const batches = all.filter(e => e.metadata.kind === 'exchange-batch');
    const indices = batches.map(b => b.metadata.batch_index as number).sort((a, b) => a - b);
    const uniqueIndices = [...new Set(indices)];
    expect(indices.length).toBe(uniqueIndices.length);
  });
});
