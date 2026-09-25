import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TimStore } from '../store.js';
import { applyRemoteEdge, localEdgeRecord, persistEdgeVersion } from '../sync-methods.js';
import { MIGRATIONS, runMigrations, setStagingEnabled } from '../schema.js';

const stores: TimStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); });
function store(): TimStore {
  const s = new TimStore(':memory:'); stores.push(s); return s;
}
const payload = (id: string) => JSON.stringify({
  id, source_id: 'source', target_id: 'target', type: 'relates', weight: 1, metadata: '{}',
});
const key = 'source|target|relates';
async function endpoints(s: TimStore): Promise<void> {
  await s.write('source', { id: 'source' }); await s.write('target', { id: 'target' });
}

describe('edge protocol convergence', () => {
  it.each([false, true])('deletion before creation, duplicate replay and stale resurrection (%s)', async reverse => {
    const s = store(); await endpoints(s);
    const events = [{ id: 'old-id', ts: 10, deleted: false }, { id: 'other-id', ts: 20, deleted: true }];
    for (const e of reverse ? events.reverse() : events) {
      applyRemoteEdge(s.getDb(), payload(e.id), e.ts, 'device-a', e.deleted);
    }
    expect(s.getDb().prepare('SELECT * FROM edges').all()).toEqual([]);
    expect(applyRemoteEdge(s.getDb(), payload('other-id'), 20, 'device-a', true)).toBe(false);
    expect(applyRemoteEdge(s.getDb(), payload('old-id'), 10, 'device-z', false)).toBe(false);
    expect(localEdgeRecord(s.getDb(), key)?.operation).toBe('delete');
  });

  it('persists a delete even before endpoints exist', () => {
    const s = store();
    expect(applyRemoteEdge(s.getDb(), payload('missing'), 20, 'origin', true)).toBe(true);
    expect(localEdgeRecord(s.getDb(), key)?.lwwDevice).toBe('origin');
  });

  it.each([false, true])('equal-time devices converge regardless of arrival order (%s)', async reverse => {
    const s = store(); await endpoints(s);
    for (const device of reverse ? ['z', 'a'] : ['a', 'z']) {
      await s.applyStaging([{ key, entityType: 'edge', operation: 'upsert', payload: payload(device),
        lwwTimestamp: 20, lwwDevice: device, lwwConfidence: 1, acked: false }]);
    }
    expect(s.getDb().prepare('SELECT id FROM edges').all()).toEqual([{ id: 'z' }]);
    expect(localEdgeRecord(s.getDb(), key)?.lwwDevice).toBe('z');
  });

  it('local unlink persists a tombstone even when staging is disabled', async () => {
    const s = store(); await endpoints(s);
    setStagingEnabled(s.getDb(), false);
    const e = await s.link('source', 'target', 'relates');
    const before = localEdgeRecord(s.getDb(), key)!;
    await s.unlink(e.id);
    const after = localEdgeRecord(s.getDb(), key)!;
    expect(after.operation).toBe('delete');
    expect(after.lwwDevice).toBe(before.lwwDevice);
    expect(applyRemoteEdge(s.getDb(), payload('stale'), before.lwwTimestamp - 1, 'z', false)).toBe(false);
  });
});

describe('additive schema v15', () => {
  it('rolls back interrupted DDL and retries idempotently', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS.filter(m => m.version < 15));
      const v15 = MIGRATIONS.find(m => m.version === 15)!;
      expect(() => runMigrations(db, [...MIGRATIONS.slice(0, -1), {
        ...v15, apply(db) { db.exec(v15.sql); throw new Error('interrupted'); },
      }], { allowMigrations: true })).toThrow('interrupted');
      expect(db.prepare('SELECT version FROM _schema_version').get()).toEqual({ version: 14 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='edge_versions'").get()).toBeUndefined();
      runMigrations(db, MIGRATIONS, { allowMigrations: true });
      db.exec(v15.sql);
      expect(db.prepare('SELECT version FROM _schema_version').get()).toEqual({ version: 15 });
    } finally { db.close(); }
  });
});
describe('edge register guards', () => {
  it('persistEdgeVersion does not move the register backwards', () => {
    const s = store();
    persistEdgeVersion(s.getDb(), payload('current'), 5000, 'a', false);
    persistEdgeVersion(s.getDb(), payload('stale'), 4990, 'b', false);
    expect(localEdgeRecord(s.getDb(), key)?.lwwTimestamp).toBe(5000);
    expect(JSON.parse(localEdgeRecord(s.getDb(), key)!.payload).id).toBe('current');
  });

  it('keeps the current edge when timestamp and device match but the payload differs', async () => {
    const s = store(); await endpoints(s);
    expect(applyRemoteEdge(s.getDb(), payload('current'), 100, 'same', false)).toBe(true);
    expect(applyRemoteEdge(s.getDb(), payload('other'), 100, 'same', false)).toBe(false);
    expect(s.getDb().prepare('SELECT id FROM edges').all()).toEqual([{ id: 'current' }]);
    expect(JSON.parse(localEdgeRecord(s.getDb(), key)!.payload).id).toBe('current');
    persistEdgeVersion(s.getDb(), payload('other'), 100, 'same', false);
    expect(JSON.parse(localEdgeRecord(s.getDb(), key)!.payload).id).toBe('current');
  });

  it('does not delete sibling rows the caller did not name', async () => {
    const s = store(); await endpoints(s);
    const insert = s.getDb().prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
       VALUES (?, 'source', 'target', 'relates', ?, ?, '2020-01-01 00:00:00')`,
    );
    insert.run('first', 0.1, '{"keep":false}');
    insert.run('second', 0.2, '{"keep":true}');
    const linked = await s.link('source', 'target', 'relates', 0.9, { fresh: true });
    const afterLink = s.getDb().prepare('SELECT id, metadata FROM edges ORDER BY rowid').all() as Array<{
      id: string; metadata: string;
    }>;
    expect(afterLink).toHaveLength(2);
    expect(afterLink.map(row => row.id)).toContain('second');
    expect(afterLink.map(row => row.id)).toContain(linked.id);
    expect(afterLink.find(row => row.id === 'second')?.metadata).toBe('{"keep":true}');
    await s.unlink('second');
    expect(s.getDb().prepare('SELECT id FROM edges').all()).toEqual([{ id: linked.id }]);
    expect(localEdgeRecord(s.getDb(), key)?.operation).toBe('upsert');
  });

  it('does not let a pre-T02 edge lose an equal-time conflict, parsing legacy datetime as UTC', async () => {
    const s = store(); await endpoints(s);
    s.getDb().prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
       VALUES ('legacy', 'source', 'target', 'relates', 1, '{}', '2020-06-15 12:00:00')`,
    ).run();
    const utc = Date.parse('2020-06-15T12:00:00.000Z');
    expect(localEdgeRecord(s.getDb(), key)?.lwwDevice).toBe('');
    expect(localEdgeRecord(s.getDb(), key)?.lwwTimestamp).toBe(utc);
    expect(applyRemoteEdge(s.getDb(), payload('remote'), utc, 'zzzz', false)).toBe(false);
    expect(applyRemoteEdge(s.getDb(), payload('older'), utc - 1, 'zzzz', false)).toBe(false);
    expect(s.getDb().prepare('SELECT id FROM edges').all()).toEqual([{ id: 'legacy' }]);
    expect(applyRemoteEdge(s.getDb(), payload('newer'), utc + 1, 'a', false)).toBe(true);
    expect(s.getDb().prepare('SELECT id FROM edges').all()).toEqual([{ id: 'newer' }]);
  });

  it('records an upsert when an endpoint is missing and does not throw', async () => {
    const s = store();
    expect(applyRemoteEdge(s.getDb(), payload('missing'), 50, 'origin', false)).toBe(true);
    expect(s.getDb().prepare('SELECT * FROM edges').all()).toEqual([]);
    expect(localEdgeRecord(s.getDb(), key)).toMatchObject({ lwwTimestamp: 50, lwwDevice: 'origin' });
    await endpoints(s);
    expect(applyRemoteEdge(s.getDb(), payload('stale'), 40, 'origin', false)).toBe(false);
    expect(s.getDb().prepare('SELECT * FROM edges').all()).toEqual([]);
  });

  it('inbox repair does not move edge_versions backwards', async () => {
    const s = store(); await endpoints(s);
    const edge = await s.link('source', 'target', 'relates');
    const high = Date.now() + 10_000_000;
    persistEdgeVersion(s.getDb(), JSON.stringify({
      id: edge.id, source_id: 'source', target_id: 'target', type: 'relates', weight: 1, metadata: '{}',
    }), high, 'future', false);
    const row = s.getDb().prepare('SELECT * FROM edges').get();
    s.stageEntryIdRewritesSync('target', [{
      sourceId: 'source', targetId: 'target', entryIds: [], edgeIds: [], priorEdges: [row as never],
    }]);
    expect(localEdgeRecord(s.getDb(), key)!.lwwTimestamp).toBeGreaterThan(high);
  });
});

it('local repeated links remain one logical edge and stale same-millisecond replay cannot undo unlink', async () => {
  const s = store(); await endpoints(s);
  await s.link('source','target','relates');
  const e = await s.link('source','target','relates',0.5);
  expect(s.getDb().prepare('SELECT COUNT(*) AS c FROM edges').get()).toEqual({c:1});
  const previous=localEdgeRecord(s.getDb(),key)!;
  await s.unlink(e.id);
  expect(localEdgeRecord(s.getDb(),key)!.lwwTimestamp).toBeGreaterThan(previous.lwwTimestamp);
  expect(applyRemoteEdge(s.getDb(),previous.payload,previous.lwwTimestamp,previous.lwwDevice,false)).toBe(false);
});
