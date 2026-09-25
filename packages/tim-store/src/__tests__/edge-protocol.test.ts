import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TimStore } from '../store.js';
import { applyRemoteEdge, localEdgeRecord } from '../sync-methods.js';
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
