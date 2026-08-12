import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TimStore } from '../store.js';
import { getUnackedStaging, ackStaging } from '../sync-methods.js';

function stage(
  db: Database.Database,
  key: string,
  payload: string,
  lww: number,
  entityType = 'entry',
): void {
  db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
    lww_timestamp, lww_device, lww_confidence)
    VALUES (?, ?, 'upsert', ?, ?, 'local', 1.0)`).run(key, entityType, payload, lww);
}

describe('staging queue stays bounded', () => {
  it('keeps only the newest unacked record per key', () => {
    const store = new TimStore(':memory:');
    const db = store.getDb();
    stage(db, 'E1', 'first', 1000);
    stage(db, 'E1', 'second', 2000);
    stage(db, 'E2', 'other', 1500);

    const rows = getUnackedStaging(db);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.key === 'E1')?.payload).toBe('second');
    store.close();
  });

  it('does not collapse across entity types', () => {
    const store = new TimStore(':memory:');
    const db = store.getDb();
    stage(db, 'K', 'as-entry', 1000, 'entry');
    stage(db, 'K', 'as-edge', 2000, 'edge');
    expect(getUnackedStaging(db)).toHaveLength(2);
    store.close();
  });

  it('never evicts an acked record, and an older record evicts nothing', () => {
    const store = new TimStore(':memory:');
    const db = store.getDb();
    stage(db, 'E1', 'pushed', 1000);
    ackStaging(db, [{ key: 'E1', lww: 1000 }]);
    stage(db, 'E1', 'newer', 2000);
    stage(db, 'E1', 'stale', 500);

    expect(db.prepare('SELECT COUNT(*) c FROM staging WHERE acked = 1').get())
      .toEqual({ c: 1 });
    const unacked = getUnackedStaging(db).map(r => r.payload).sort();
    expect(unacked).toEqual(['newer', 'stale']);
    store.close();
  });

  it('ack leaves a record staged after the push went out', () => {
    const store = new TimStore(':memory:');
    const db = store.getDb();
    stage(db, 'E1', 'in flight', 1000);
    // A write lands mid-push: the trigger replaces the record being pushed.
    stage(db, 'E1', 'written during push', 2000);
    // The push confirms what it actually sent.
    ackStaging(db, [{ key: 'E1', lww: 1000 }]);

    const unacked = getUnackedStaging(db);
    expect(unacked).toHaveLength(1);
    expect(unacked[0].payload).toBe('written during push');
    store.close();
  });

  it('stages nothing at all when staging is off, and resumes when it is back on', async () => {
    const off = new TimStore(':memory:', { staging: false });
    const entry = await off.write('Title\nbody');
    await off.update(entry.id, { content: 'changed' });
    expect(getUnackedStaging(off.getDb())).toHaveLength(0);
    // The write itself is unaffected — only the outbox record is dropped.
    expect((await off.read(entry.id))?.content).toBe('changed');
    off.close();

    const on = new TimStore(':memory:', { staging: true });
    await on.write('Title\nbody');
    expect(getUnackedStaging(on.getDb()).length).toBeGreaterThan(0);
    on.close();
  });

  it('lets an inbound record through while the outbox is off', () => {
    const store = new TimStore(':memory:', { staging: false });
    const db = store.getDb();
    // What a pull applies locally carries acked = 1; only outbox rows are suppressed.
    db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence, acked)
      VALUES ('E1', 'entry', 'upsert', 'inbound', 1000, 'remote', 1.0, 1)`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM staging').get()).toEqual({ c: 1 });
    store.close();
  });

  it('purgeStaging drops the outbox including what was never pushed', async () => {
    const store = new TimStore(':memory:', { staging: true });
    const db = store.getDb();
    stage(db, 'ACKED', 'x', Date.now());
    ackStaging(db, [{ key: 'ACKED', lww: Date.now() }]);
    stage(db, 'UNACKED', 'y', Date.now());

    expect(await store.purgeStaging()).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM staging').get()).toEqual({ c: 0 });
    store.close();
  });

  it('gcStaging drops acked records older than the cutoff', async () => {
    const store = new TimStore(':memory:');
    const db = store.getDb();
    stage(db, 'OLD', 'x', Date.now() - 30 * 86400_000);
    stage(db, 'NEW', 'y', Date.now());
    ackStaging(db, [
      { key: 'OLD', lww: Date.now() },
      { key: 'NEW', lww: Date.now() },
    ]);

    expect(await store.gcStaging(7)).toBe(1);
    expect(db.prepare('SELECT key FROM staging').all()).toEqual([{ key: 'NEW' }]);
    store.close();
  });
});
