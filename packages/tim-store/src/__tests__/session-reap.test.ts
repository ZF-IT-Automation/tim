import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager, findChildByKind, KIND_EXCHANGE_BATCH, KIND_EXCHANGES_ROOT, KIND_SUMMARY_ROOT, KIND_BATCH, reapEmptySessions, reapSessionsById, EMPTY_SESSION_AGE_FLOOR_MS } from '../index.js';

const HOUR = 60 * 60 * 1000;
const OLD = EMPTY_SESSION_AGE_FLOOR_MS + HOUR;

describe('empty session reap', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0091', { content: 'reap fixture' });
  });

  afterEach(() => {
    store.close();
  });

  async function emptySession(id: string, extra: { taskSummary?: string } = {}) {
    return sessions.startProjectSession({
      sessionId: id,
      projectId: 'P0091',
      agentName: 'a',
      cwd: '/',
      harness: 'test',
      ...(extra.taskSummary ? { taskSummary: extra.taskSummary } : {}),
    });
  }

  function age(id: string, msAgo: number) {
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - msAgo).toISOString(),
      id,
    );
  }

  function deleteRecords(): number {
    const row = store.getDb().prepare(
      `SELECT COUNT(*) AS n FROM staging WHERE operation = 'delete'`,
    ).get() as { n: number };
    return row.n;
  }

  function liveNodes(rootId: string): number {
    const row = store.getDb().prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e JOIN sub ON e.parent_id = sub.id
      )
      SELECT COUNT(*) AS n FROM entries
      WHERE id IN (SELECT id FROM sub) AND tombstoned_at IS NULL
    `).get(rootId) as { n: number };
    return row.n;
  }

  it('reaps a session with zero exchanges and removes the subtree', async () => {
    await emptySession('bare');
    age('bare', OLD);
    await emptySession('keeper');
    const summary = await findChildByKind(store, 'bare', KIND_SUMMARY_ROOT);
    const exchanges = await findChildByKind(store, 'bare', KIND_EXCHANGES_ROOT);
    expect(summary).not.toBeNull();
    expect(exchanges).not.toBeNull();

    const before = deleteRecords();
    const result = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(result.reaped.map(row => row.sessionId)).toEqual(['bare']);
    expect(result.reaped[0]?.childCount).toBe(2);
    expect(result.suspicious).toEqual([]);
    expect(await store.read('bare')).toBeNull();
    expect(await store.read(summary!.id)).toBeNull();
    expect(await store.read(exchanges!.id)).toBeNull();
    expect(liveNodes('bare')).toBe(0);
    expect(deleteRecords() - before).toBe(3);
    expect(await store.read('keeper')).not.toBeNull();
  });

  it('second run writes no new delete records', async () => {
    await emptySession('bare');
    age('bare', OLD);
    await emptySession('keeper');

    await reapEmptySessions(store, { projectIds: ['P0091'] });
    const afterFirst = deleteRecords();
    const again = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(again.reaped).toEqual([]);
    expect(deleteRecords()).toBe(afterFirst);
  });

  it('does not reap a session that still has an irrelevant exchange', async () => {
    await emptySession('hid');
    const written = await sessions.logExchange('hid', [{ role: 'user', content: 'hidden note' }]);
    await store.update(written[0]!.id, { irrelevant: true });
    age('hid', OLD);
    await emptySession('keeper');

    const result = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(result.reaped).toEqual([]);
    expect(await store.read('hid')).not.toBeNull();
  });

  it('does not reap a session with an empty interior exchange batch', async () => {
    await emptySession('gap');
    const exchanges = await findChildByKind(store, 'gap', KIND_EXCHANGES_ROOT);
    await store.write('Batch 1', {
      parentId: exchanges!.id,
      metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: 1 },
    });
    await store.write('Batch 2', {
      parentId: exchanges!.id,
      metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: 2 },
    });
    age('gap', OLD);
    await emptySession('keeper');

    const result = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(result.reaped).toEqual([]);
    expect(result.suspicious.map(row => row.sessionId)).toEqual(['gap']);
    expect(await store.read('gap')).not.toBeNull();
  });

  it('does not reap the newest session of a project', async () => {
    await emptySession('older');
    await emptySession('newer');
    age('older', OLD + HOUR);
    age('newer', OLD);

    const result = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(result.reaped.map(row => row.sessionId)).toEqual(['older']);
    expect(await store.read('newer')).not.toBeNull();
  });

  it('does not reap a session with a hand-written body', async () => {
    await emptySession('noted');
    await store.update('noted', { content: 'hand written' });
    age('noted', OLD);
    await emptySession('keeper');

    const result = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(result.reaped).toEqual([]);
    expect(await store.read('noted')).not.toBeNull();
  });

  it('does not reap a session younger than 24h', async () => {
    await emptySession('young');
    age('young', EMPTY_SESSION_AGE_FLOOR_MS - HOUR);
    await emptySession('keeper');

    const result = await reapEmptySessions(store, { projectIds: ['P0091'] });

    expect(result.reaped).toEqual([]);
    expect(await store.read('young')).not.toBeNull();
  });

  it('does not reap the running session or a non-empty summary', async () => {
    await emptySession('running');
    age('running', OLD);
    await emptySession('summarized');
    const summary = await findChildByKind(store, 'summarized', KIND_SUMMARY_ROOT);
    await store.update(summary!.id, { content: 'real summary' });
    age('summarized', OLD);
    await emptySession('tasked', { taskSummary: 'ship the hook' });
    age('tasked', OLD);
    const summaryWithBatch = await emptySession('batched');
    const batchedSummary = await findChildByKind(store, summaryWithBatch.id, KIND_SUMMARY_ROOT);
    await store.write('rolled', {
      parentId: batchedSummary!.id,
      metadata: { kind: KIND_BATCH, batch_index: 1 },
    });
    age('batched', OLD);
    await emptySession('keeper');

    const result = await reapEmptySessions(store, {
      projectIds: ['P0091'],
      currentSessionId: 'running',
    });

    expect(result.reaped).toEqual([]);
    expect(await store.read('running')).not.toBeNull();
    expect(await store.read('summarized')).not.toBeNull();
    expect(await store.read('tasked')).not.toBeNull();
    expect(await store.read('batched')).not.toBeNull();
  });

  it('dry-run reports the session and leaves it in place', async () => {
    await emptySession('bare');
    age('bare', OLD);
    await emptySession('keeper');

    const result = await reapEmptySessions(store, { projectIds: ['P0091'], dryRun: true });

    expect(result.reaped.map(row => row.sessionId)).toEqual(['bare']);
    expect(await store.read('bare')).not.toBeNull();
    expect(deleteRecords()).toBe(0);
  });

  it('caps reaps and leaves other projects alone', async () => {
    await store.createProject('P0092', { content: 'other' });
    await sessions.startProjectSession({
      sessionId: 'other-old',
      projectId: 'P0092',
      agentName: 'a',
      cwd: '/',
      harness: 'test',
    });
    age('other-old', OLD);
    await sessions.startProjectSession({
      sessionId: 'other-keeper',
      projectId: 'P0092',
      agentName: 'a',
      cwd: '/',
      harness: 'test',
    });

    for (const id of ['s0', 's1', 's2']) {
      await emptySession(id);
      age(id, OLD + HOUR);
    }
    await emptySession('keeper');

    const capped = await reapEmptySessions(store, { projectIds: ['P0091'], cap: 2, dryRun: true });
    expect(capped.reaped.map(row => row.sessionId)).toEqual(['s0', 's1']);

    await reapEmptySessions(store, { projectIds: ['P0091'] });
    expect(await store.read('other-old')).not.toBeNull();
    expect(await store.read('s0')).toBeNull();
  });

  it('reaps explicit ids without the emptiness predicate and refuses the running session', async () => {
    await emptySession('junk');
    await sessions.logExchange('junk', [{ role: 'user', content: 'not empty' }]);
    await emptySession('running');
    const before = deleteRecords();

    const dry = await reapSessionsById(store, ['junk', 'running'], {
      currentSessionId: 'running',
      dryRun: true,
    });
    expect(dry.reaped.map(row => row.sessionId)).toEqual(['junk']);
    expect(dry.refused).toEqual([
      { sessionId: 'running', childCount: 2, reason: 'running' },
    ]);
    expect(dry.reaped[0]?.childCount).toBeGreaterThan(0);
    expect(await store.read('junk')).not.toBeNull();

    const result = await reapSessionsById(store, ['junk', 'running', 'missing-id'], {
      currentSessionId: 'running',
    });

    expect(result.reaped.map(row => row.sessionId)).toEqual(['junk']);
    expect(result.refused.map(row => row.sessionId)).toEqual(['running']);
    expect(result.missing).toEqual(['missing-id']);
    expect(await store.read('junk')).toBeNull();
    expect(liveNodes('junk')).toBe(0);
    expect(await store.read('running')).not.toBeNull();
    expect(deleteRecords()).toBeGreaterThan(before);

    const after = deleteRecords();
    const again = await reapSessionsById(store, ['junk'], { currentSessionId: 'running' });
    expect(again.missing).toEqual(['junk']);
    expect(again.reaped).toEqual([]);
    expect(deleteRecords()).toBe(after);
  });
});
