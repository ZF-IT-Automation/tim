// searchFts retries once when the FTS vtable cannot be constructed (seen once under concurrent writers).

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { TimStore } from '../store.js';

describe('searchFts vtable retry', () => {
  it('retries once on "vtable constructor failed" and returns the hits', async () => {
    const dbPath = `/tmp/tim-fts-retry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const store = new TimStore(dbPath);
    try {
      await store.write('Retry target\nfindable body');
      const db = (store as unknown as { db: { prepare: (sql: string) => unknown } }).db;
      const real = db.prepare.bind(db);
      let thrown = false;
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (!thrown && sql.includes('fts_entries MATCH')) {
          thrown = true;
          throw Object.assign(new Error('vtable constructor failed: fts_entries'), { code: 'SQLITE_ERROR' });
        }
        return real(sql);
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const hits = await store.searchFts('findable', 5);
      expect(thrown).toBe(true);
      expect(hits.map(h => h.title)).toContain('Retry target');
      expect(errSpy.mock.calls[0]?.[0]).toMatch(/schema_version=\d+/);
      spy.mockRestore();
      errSpy.mockRestore();
    } finally {
      store.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    }
  });
});
