import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('health() orphan metric', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-health-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('an ordinary leaf without edges is NOT an orphan', async () => {
    const root = await store.write('Root\nbody');
    await store.write('Leaf\nbody', { parentId: root.id });
    const report = await store.health();
    expect(report.orphanEntries).toBe(0);
  });

  it('an entry whose parent_id points nowhere IS an orphan', async () => {
    const root = await store.write('Root\nbody');
    const child = await store.write('Child\nbody', { parentId: root.id });
    // Break the link at the raw level (simulates partial deletes/imports).
    store.getDb().prepare('UPDATE entries SET parent_id = ? WHERE id = ?')
      .run('GONE-0000000000000000000000', child.id);
    const report = await store.health();
    expect(report.orphanEntries).toBe(1);
  });

  it('an entry under a tombstoned parent IS an orphan', async () => {
    const root = await store.write('Root\nbody');
    await store.write('Child\nbody', { parentId: root.id });
    await store.delete(root.id, true); // tombstone the parent
    const report = await store.health();
    expect(report.orphanEntries).toBe(1);
  });
});
