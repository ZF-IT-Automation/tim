import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, ensureInboxProject } from '../index.js';
import type { Entry } from 'tim-core';

describe('concurrent TimStore', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `tim-concurrent-${crypto.randomBytes(8).toString('hex')}.db`,
    );
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
      } catch {
        // ignore cleanup races
      }
    }
  });

  it('busy_timeout allows concurrent writers to wait', async () => {
    const store1 = new TimStore(dbPath);
    const store2 = new TimStore(dbPath);

    try {
      const [entry1, entry2] = await Promise.all([
        store1.createProject('P1001', { content: 'Project A' }),
        store2.createProject('P1002', { content: 'Project B' }),
      ]);

      expect(entry1.metadata.label).toBe('P1001');
      expect(entry2.metadata.label).toBe('P1002');
    } finally {
      store1.close();
      store2.close();
    }
  });

  it('concurrent createProject with same label — exactly one succeeds', async () => {
    const store1 = new TimStore(dbPath);
    const store2 = new TimStore(dbPath);

    try {
      const [result1, result2] = await Promise.all([
        store1.createProject('P9999').then(
          (entry): { ok: true; entry: Entry } => ({ ok: true, entry }),
          (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
        ),
        store2.createProject('P9999').then(
          (entry): { ok: true; entry: Entry } => ({ ok: true, entry }),
          (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
        ),
      ]);

      expect(result1.ok !== result2.ok).toBe(true);

      const success = result1.ok ? result1 : result2;
      const failure = result1.ok ? result2 : result1;

      expect(success.ok).toBe(true);
      if (success.ok) {
        expect(success.entry.metadata.label).toBe('P9999');
      }

      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error).toBeInstanceOf(Error);
        expect(String(failure.error)).toMatch(
          /Project label already exists|SQLITE_CONSTRAINT|UNIQUE/i,
        );
      }
    } finally {
      store1.close();
      store2.close();
    }
  });

  it('concurrent ensureInboxProject calls converge on one row and one staging write', async () => {
    const store1 = new TimStore(dbPath);
    const store2 = new TimStore(dbPath);

    try {
      const [first, second] = await Promise.all([
        ensureInboxProject(store1),
        ensureInboxProject(store2),
      ]);

      expect(first.id).toBe('P0000');
      expect(second.id).toBe('P0000');
      const row = store1.getDb().prepare(
        `SELECT COUNT(*) AS count FROM entries WHERE id = 'P0000'`,
      ).get() as { count: number };
      const staging = store1.getDb().prepare(
        `SELECT COUNT(*) AS count FROM staging WHERE key = 'P0000'`,
      ).get() as { count: number };
      expect(row.count).toBe(1);
      expect(staging.count).toBe(1);
    } finally {
      store1.close();
      store2.close();
    }
  });
});
