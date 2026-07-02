import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../index.js';
import fs from 'node:fs';

function tmp(name: string): string {
  return `/tmp/tim-conv-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    for (const s of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + s); } catch { /* ignore */ }
    }
  }
}

/** Comparable projection — excludes volatile columns (accessed_at etc.). */
function entryRow(store: TimStore, id: string): Record<string, unknown> | undefined {
  return store.getDb().prepare(
    'SELECT id, title, content, irrelevant, tombstoned_at, metadata FROM entries WHERE id = ?',
  ).get(id) as Record<string, unknown> | undefined;
}

describe('sync convergence', () => {
  let a: TimStore; let b: TimStore;
  let pa: string; let pb: string;

  beforeEach(() => {
    pa = tmp('a'); pb = tmp('b');
    a = new TimStore(pa); b = new TimStore(pb);
  });

  afterEach(() => {
    a.close(); b.close();
    cleanup([pa, pb]);
  });

  it('concurrent edits to the same entry converge to the newer write on both replicas', async () => {
    const shared = 'SHARED0000000000000000ENTRY';
    await a.write('From A\nolder', { id: shared });
    await new Promise(r => setTimeout(r, 5)); // strictly newer wall clock
    await b.write('From B\nnewer', { id: shared });

    const fromA = await a.getStaging();
    const fromB = await b.getStaging();
    await b.applyStaging(fromA);
    await a.applyStaging(fromB);

    const rowA = entryRow(a, shared);
    const rowB = entryRow(b, shared);
    expect(rowA).toEqual(rowB);
    expect(rowA!.title).toBe('From B');
  });

  it('apply order does not matter on fresh replicas', async () => {
    const shared = 'SHARED0000000000000000ORDER';
    await a.write('Alpha\nversion', { id: shared });
    await new Promise(r => setTimeout(r, 5));
    await b.write('Beta\nversion', { id: shared });

    const stagingA = await a.getStaging();
    const stagingB = await b.getStaging();

    const p1 = tmp('r1'); const p2 = tmp('r2');
    const r1 = new TimStore(p1); const r2 = new TimStore(p2);
    try {
      await r1.applyStaging(stagingA);
      await r1.applyStaging(stagingB);
      await r2.applyStaging(stagingB);
      await r2.applyStaging(stagingA);
      expect(entryRow(r1, shared)).toEqual(entryRow(r2, shared));
      expect(entryRow(r1, shared)!.title).toBe('Beta');
    } finally {
      r1.close(); r2.close();
      cleanup([p1, p2]);
    }
  });

  it('older remote delete loses against newer local update on both replicas', async () => {
    const shared = 'SHARED00000000000000DELUPD';
    await a.write('Victim\nbody', { id: shared });
    await b.applyStaging(await a.getStaging()); // both replicas have it

    await a.delete(shared, true);             // A tombstones (older write ts)
    await new Promise(r => setTimeout(r, 5));
    await b.update(shared, { content: 'Victim\nsurvives' }); // B updates (newer)

    const delRecords = (await a.getStaging()).filter(r => r.key === shared && r.operation === 'delete');
    const updRecords = (await b.getStaging()).filter(r => r.key === shared && r.operation === 'upsert');
    await b.applyStaging(delRecords);
    await a.applyStaging(updRecords);

    const rowA = entryRow(a, shared);
    const rowB = entryRow(b, shared);
    expect(rowB).toBeDefined();
    expect(rowA?.content ?? null).toEqual(rowB?.content ?? null);
    expect(rowB!.content).toBe('Victim\nsurvives');
  });

  it('identical timestamps converge via device-id tiebreak on both replicas', async () => {
    const shared = 'SHARED000000000000000TIEBRK';
    const ts = Date.now();
    const iso = new Date(ts).toISOString();
    const mkRecord = (device: string, title: string) => ({
      key: shared,
      entityType: 'entry' as const,
      operation: 'upsert' as const,
      payload: JSON.stringify({
        id: shared, parent_id: null, title, content: '',
        content_type: 'text', depth: 1, confidence: 1,
        created_at: iso, accessed_at: iso, updated_at: iso,
        decay_rate: 0, visibility: 1, tags: '[]',
        irrelevant: 0, favorite: 0, tombstoned_at: null, metadata: '{}',
        lww_device: device,
      }),
      lwwTimestamp: ts,
      lwwDevice: device,
      lwwConfidence: 1,
      acked: false,
    });

    // Opposite arrival orders on the two replicas.
    await a.applyStaging([mkRecord('device-aaa', 'A version')]);
    await a.applyStaging([mkRecord('device-zzz', 'Z version')]);
    await b.applyStaging([mkRecord('device-zzz', 'Z version')]);
    await b.applyStaging([mkRecord('device-aaa', 'A version')]);

    const rowA = entryRow(a, shared);
    const rowB = entryRow(b, shared);
    expect(rowA!.title).toEqual(rowB!.title);
    expect(rowA!.title).toBe('Z version'); // device-zzz > device-aaa, deterministically
  });
});
