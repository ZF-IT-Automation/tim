import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('entry_usage recording', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records reads and marks them referenced within the same session', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    const b = await store.write('Entry B\nBody.', { tags: ['#x', '#y'] });

    store.recordRead([a.id, b.id], 'session-1');
    expect(new Set(store.getSessionReadIds('session-1'))).toEqual(new Set([a.id, b.id]));

    // Only A gets used afterwards.
    const flipped = store.markReferenced([a.id], 'session-1');
    expect(flipped).toBe(1);

    const counts = store.getReferenceCounts([a.id, b.id]);
    expect(counts.get(a.id)).toBe(1);
    expect(counts.get(b.id)).toBeUndefined();
  });

  it('markReferenced is scoped to the session that read the entry', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    store.recordRead([a.id], 'session-1');
    // A different session referencing without having read: no-op.
    expect(store.markReferenced([a.id], 'session-2')).toBe(0);
    expect(store.markReferenced([a.id], null)).toBe(0);
  });

  it('accumulates reference counts across sessions', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    for (const sid of ['s1', 's2', 's3']) {
      store.recordRead([a.id], sid);
      store.markReferenced([a.id], sid);
    }
    expect(store.getReferenceCounts([a.id]).get(a.id)).toBe(3);
  });

  it('never stages usage rows for sync', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    const cursor = await store.getStagingCursor();
    store.recordRead([a.id], 's1');
    store.markReferenced([a.id], 's1');
    expect(await store.getStagingCursor()).toBe(cursor);
  });
});
