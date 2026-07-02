// TIM Store — update() symmetric flags tests (Plan 1, Task 2)
//
// update(id, { irrelevant: false }) must restore a soft-deleted entry.
// update(id, { tombstonedAt: null }) must clear a tombstone.
// update without the flag must leave it untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('update() symmetric flags', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-updsym-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('update(irrelevant:false) restores a soft-deleted entry', async () => {
    const entry = await store.write('Restorable\nbody');
    await store.update(entry.id, { irrelevant: true });
    expect(await store.read(entry.id)).toBeNull();

    await store.update(entry.id, { irrelevant: false });
    const restored = await store.read(entry.id);
    expect(restored).not.toBeNull();
    expect(restored!.irrelevant).toBe(false);
  });

  it('update without irrelevant in patch leaves the flag untouched', async () => {
    const entry = await store.write('Keep flag\nbody');
    await store.update(entry.id, { irrelevant: true });
    await store.update(entry.id, { content: 'Keep flag\nnew body' });
    const row = await store.read(entry.id, { showIrrelevant: true });
    expect(row!.irrelevant).toBe(true);
  });

  it('update(tombstonedAt:null) clears a tombstone', async () => {
    const entry = await store.write('Untombable\nbody');
    await store.delete(entry.id, true); // hard delete = tombstone
    await store.update(entry.id, { tombstonedAt: null });
    const restored = await store.read(entry.id);
    expect(restored).not.toBeNull();
    expect(restored!.tombstonedAt).toBeNull();
  });
});