import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { TimStore, applyRemoteEntry } from '../index.js';
import type { StagingRecord } from 'tim-core';

function tmp(name: string): string {
  return `/tmp/tim-tombstone-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    for (const s of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + s); } catch { /* ignore */ }
    }
  }
}

const ENTRY_ID = 'TOMB00000000000000000001';
const ENTRY_ID_2 = 'TOMB00000000000000000002';

function mkUpsertRecord(id: string, ts: number, content: string, device = 'dev-a'): StagingRecord {
  const iso = new Date(ts).toISOString();
  return {
    key: id,
    entityType: 'entry',
    operation: 'upsert',
    lwwTimestamp: ts,
    lwwDevice: device,
    lwwConfidence: 1,
    acked: false,
    payload: JSON.stringify({
      id,
      parent_id: null,
      title: 'title',
      content,
      content_type: 'text',
      depth: 1,
      confidence: 1,
      created_at: iso,
      accessed_at: iso,
      updated_at: iso,
      decay_rate: 0,
      visibility: 1,
      tags: '[]',
      irrelevant: 0,
      favorite: 0,
      tombstoned_at: null,
      metadata: '{}',
      lww_device: device,
    }),
  };
}

function mkDeleteRecord(id: string, ts: number, device = 'dev-a'): StagingRecord {
  return {
    key: id,
    entityType: 'entry',
    operation: 'delete',
    lwwTimestamp: ts,
    lwwDevice: device,
    lwwConfidence: 1,
    acked: false,
    payload: JSON.stringify({
      id,
      tombstoned_at: new Date(ts).toISOString(),
      lww_device: device,
    }),
  };
}

function tombstoneRow(store: TimStore, id: string): { tombstoned_at: string | null; content: string } | undefined {
  return store.getDb().prepare(
    'SELECT tombstoned_at, content FROM entries WHERE id = ?',
  ).get(id) as { tombstoned_at: string | null; content: string } | undefined;
}

describe('sync tombstones', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmp('main');
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    cleanup([dbPath]);
  });

  it('applyStaging: upsert@1000, delete@3000, delayed upsert@2000 stays deleted', async () => {
    await store.applyStaging([mkUpsertRecord(ENTRY_ID, 1000, 'v1')]);
    await store.applyStaging([mkDeleteRecord(ENTRY_ID, 3000)]);
    await store.applyStaging([mkUpsertRecord(ENTRY_ID, 2000, 'resurrect')]);

    const row = tombstoneRow(store, ENTRY_ID);
    expect(row?.tombstoned_at).not.toBeNull();
    expect(row?.content).toBe('v1');
    expect(store.readSync(ENTRY_ID)).toBeNull();
  });

  it('applyStaging: delete of unknown id prevents older creation', async () => {
    await store.applyStaging([mkDeleteRecord(ENTRY_ID, 3000)]);
    await store.applyStaging([mkUpsertRecord(ENTRY_ID, 1000, 'too old')]);

    expect(tombstoneRow(store, ENTRY_ID)?.tombstoned_at).not.toBeNull();
    expect(store.readSync(ENTRY_ID)).toBeNull();
  });

  it('applyStaging: newer upsert restores after older delete', async () => {
    await store.applyStaging([mkUpsertRecord(ENTRY_ID, 1000, 'original')]);
    await store.applyStaging([mkDeleteRecord(ENTRY_ID, 2000)]);
    await store.applyStaging([mkUpsertRecord(ENTRY_ID, 3000, 'restored')]);

    const row = tombstoneRow(store, ENTRY_ID);
    expect(row?.tombstoned_at).toBeNull();
    expect(store.readSync(ENTRY_ID)?.content).toBe('restored');
  });

  it('applyRemoteEntry: delete of unknown id prevents older creation', () => {
    const db = store.getDb();
    const delPayload = JSON.stringify({
      id: ENTRY_ID_2,
      tombstoned_at: new Date(3000).toISOString(),
      lww_device: 'dev-b',
    });
    expect(applyRemoteEntry(db, delPayload, 3000, 'dev-b', true)).toBe(true);
    expect(applyRemoteEntry(db, mkUpsertRecord(ENTRY_ID_2, 1000, 'resurrect').payload, 1000, 'dev-a', false)).toBe(false);

    expect(tombstoneRow(store, ENTRY_ID_2)?.tombstoned_at).not.toBeNull();
    expect(store.readSync(ENTRY_ID_2)).toBeNull();
  });

  it('applyRemoteEntry and applyStaging agree on tombstone conflict', async () => {
    const pathA = tmp('a');
    const pathB = tmp('b');
    const a = new TimStore(pathA);
    const b = new TimStore(pathB);
    try {
      const records = [
        mkUpsertRecord(ENTRY_ID, 1000, 'v1'),
        mkDeleteRecord(ENTRY_ID, 3000),
        mkUpsertRecord(ENTRY_ID, 2000, 'delayed'),
      ];

      for (const record of records) {
        if (record.operation === 'delete') {
          const payload = JSON.parse(record.payload) as { id: string };
          applyRemoteEntry(
            a.getDb(),
            record.payload,
            record.lwwTimestamp,
            record.lwwDevice,
            true,
          );
        } else {
          applyRemoteEntry(
            a.getDb(),
            record.payload,
            record.lwwTimestamp,
            record.lwwDevice,
            false,
          );
        }
      }
      await b.applyStaging(records);

      expect(tombstoneRow(a, ENTRY_ID)).toEqual(tombstoneRow(b, ENTRY_ID));
      expect(a.readSync(ENTRY_ID)).toBeNull();
      expect(b.readSync(ENTRY_ID)).toBeNull();
    } finally {
      a.close();
      b.close();
      cleanup([pathA, pathB]);
    }
  });

  it('identical timestamps use device tiebreak for delete vs upsert on both paths', async () => {
    const ts = 5000;
    const pathA = tmp('tie-a');
    const pathB = tmp('tie-b');
    const a = new TimStore(pathA);
    const b = new TimStore(pathB);
    try {
      const del = mkDeleteRecord(ENTRY_ID, ts, 'device-zzz');
      const ups = mkUpsertRecord(ENTRY_ID, ts, 'survivor', 'device-aaa');

      applyRemoteEntry(a.getDb(), del.payload, ts, 'device-zzz', true);
      applyRemoteEntry(a.getDb(), ups.payload, ts, 'device-aaa', false);

      await b.applyStaging([del, ups]);

      expect(tombstoneRow(a, ENTRY_ID)?.tombstoned_at).not.toBeNull();
      expect(tombstoneRow(b, ENTRY_ID)?.tombstoned_at).not.toBeNull();
      expect(a.readSync(ENTRY_ID)).toBeNull();
      expect(b.readSync(ENTRY_ID)).toBeNull();
    } finally {
      a.close();
      b.close();
      cleanup([pathA, pathB]);
    }
  });
});
