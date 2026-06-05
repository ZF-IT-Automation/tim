import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { TimStore } from '../store.js';
import { runMigrations } from '../schema.js';

describe('reconcileMetadataTypes', () => {
  let dbPath: string;
  let store: TimStore;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `tim-reconcile-${Date.now()}.db`);
    db = new Database(dbPath);
    runMigrations(db);
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  function insertBadEntry(id: string, metadata: string): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO entries
      (id, parent_id, title, content, content_type, depth, confidence, created_at,
       accessed_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
      VALUES (?, NULL, ?, '', 'text', 1, 1, ?, ?, 0, 1, '[]', 0, 0, NULL, ?)`).run(
      id,
      `Entry ${id}`,
      now,
      now,
      metadata,
    );
  }

  it('coerces legacy task metadata on reconcile', async () => {
    insertBadEntry('BAD001', JSON.stringify({ task: 1, status: 'done' }));
    insertBadEntry('BAD002', JSON.stringify({ task: 'true', status: 'todo' }));
    insertBadEntry('BAD003', JSON.stringify({ task: 1 }));

    expect(store.findEntriesWithNonBooleanTask()).toHaveLength(3);

    const result = await store.reconcileMetadataTypes();
    expect(result).toEqual({ found: 3, updated: 3, skipped: 0 });

    for (const id of ['BAD001', 'BAD002', 'BAD003']) {
      const row = db.prepare('SELECT metadata FROM entries WHERE id = ?').get(id) as {
        metadata: string;
      };
      const meta = JSON.parse(row.metadata);
      expect(meta.task).toBe(true);
      expect(typeof meta.task).toBe('boolean');
    }

    expect(store.findEntriesWithNonBooleanTask()).toHaveLength(0);
  });

  it('dry-run does not write', async () => {
    insertBadEntry('DRY001', JSON.stringify({ task: 1 }));

    const result = await store.reconcileMetadataTypes({ dryRun: true });
    expect(result).toEqual({ found: 1, updated: 1, skipped: 0 });

    const row = db.prepare('SELECT metadata FROM entries WHERE id = ?').get('DRY001') as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata).task).toBe(1);
  });
});
