import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from '../store.js';
import { ackStaging, getUnackedStaging, applyRemoteEntry } from '../sync-methods.js';

describe('sync-methods', () => {
  let dbPath: string;
  let store: TimStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `tim-sync-methods-${Date.now()}.db`);
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('acks staging keys', async () => {
    await store.write('hello');
    const db = store.getDb();
    expect(getUnackedStaging(db).length).toBe(1);
    ackStaging(db, [getUnackedStaging(db)[0].key]);
    expect(getUnackedStaging(db).length).toBe(0);
  });

  it('applyRemoteEntry upserts when newer', async () => {
    await store.write('local', { id: 'REMOTE01' });
    const db = store.getDb();
    const payload = JSON.stringify({
      id: 'REMOTE01',
      parent_id: null,
      content: 'remote wins',
      content_type: 'text',
      depth: 1,
      confidence: 1,
      created_at: new Date().toISOString(),
      accessed_at: new Date().toISOString(),
      decay_rate: 0,
      visibility: 1,
      tags: '[]',
      irrelevant: 0,
      favorite: 0,
      tombstoned_at: null,
      metadata: '{}',
    });
    const applied = applyRemoteEntry(db, payload, Date.now() + 10_000, 'remote', false);
    expect(applied).toBe(true);
    const entry = await store.read('REMOTE01');
    expect(entry?.content).toBe('remote wins');
  });
});
