// Import sync-readiness tests — Task 2 (titles + staging) and Task 3 (dedup merge writes)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { TimStore } from 'tim-store';
import { tim_import } from '../import.js';
import { createV2HmemDatabase } from '../hmem-format.js';

describe('tim_import sync-readiness', () => {
  let store: TimStore;
  let dbPath: string;
  let sourcePath: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbPath = `/tmp/tim-impsync-${stamp}.db`;
    sourcePath = `/tmp/tim-impsync-src-${stamp}.hmem`;
    store = new TimStore(dbPath);

    const src = createV2HmemDatabase(sourcePath);
    src.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned)
      VALUES ('uid-root-1', 'L0001', 'L', 1,
        'Lesson title line' || char(10) || 'Lesson body text',
        '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0, 0, 0, 0, 0)
    `).run();
    src.prepare(`
      INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content,
        created_at, updated_at, irrelevant)
      VALUES ('uid-node-1', 'uid-root-1', NULL, 2, 1, 'Node line one' || char(10) || 'node body',
        '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
    `).run();
    src.prepare(`
      INSERT INTO links (src_uid, dst_uid, kind) VALUES ('uid-root-1', 'uid-node-1', 'relates')
    `).run();
    src.close();
  });

  afterEach(() => {
    store.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, sourcePath]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('imported entries have titles split from the first content line', async () => {
    tim_import(store, sourcePath);
    const root = store.getDb().prepare(
      "SELECT title, content FROM entries WHERE json_extract(metadata, '$.hmemUid') = 'uid-root-1'",
    ).get() as { title: string; content: string };
    expect(root.title).toBe('Lesson title line');
    expect(root.content).toBe('Lesson body text');
  });

  it('imported entries and edges appear in sync staging', async () => {
    tim_import(store, sourcePath);
    const entryStaging = store.getDb().prepare(
      "SELECT COUNT(*) AS c FROM staging WHERE entity_type = 'entry' AND acked = 0",
    ).get() as { c: number };
    const edgeStaging = store.getDb().prepare(
      "SELECT COUNT(*) AS c FROM staging WHERE entity_type = 'edge' AND acked = 0",
    ).get() as { c: number };
    expect(entryStaging.c).toBeGreaterThanOrEqual(2); // root + node
    expect(edgeStaging.c).toBeGreaterThanOrEqual(1);
  });

  it('staging payloads parse as full row objects with updated_at', async () => {
    tim_import(store, sourcePath);
    const row = store.getDb().prepare(
      "SELECT payload FROM staging WHERE entity_type = 'entry' LIMIT 1",
    ).get() as { payload: string };
    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    expect(parsed.id).toBeTruthy();
    expect(parsed.title).toBeDefined();
    expect(parsed.updated_at).toBeTruthy();
    expect(parsed.metadata).toBeTruthy();
  });

  it('dry-run writes neither entries nor staging', async () => {
    tim_import(store, sourcePath, { dryRun: true });
    const entries = store.getDb().prepare(
      "SELECT COUNT(*) AS c FROM entries WHERE json_extract(metadata, '$.hmemUid') IS NOT NULL",
    ).get() as { c: number };
    const staging = store.getDb().prepare('SELECT COUNT(*) AS c FROM staging').get() as { c: number };
    expect(entries.c).toBe(0);
    expect(staging.c).toBe(0);
  });

  it('re-import with deduplicate writes changed root content', async () => {
    tim_import(store, sourcePath);

    // Change the source content, then re-import with force+deduplicate.
    const src = new Database(sourcePath);
    src.prepare("UPDATE entries SET level_1 = 'Lesson title line' || char(10) || 'REVISED body' WHERE uid = 'uid-root-1'").run();
    src.close();

    const report = tim_import(store, sourcePath, { deduplicate: true, force: true });
    expect(report.changedCount).toBeGreaterThanOrEqual(1);

    const row = store.getDb().prepare(
      "SELECT content FROM entries WHERE json_extract(metadata, '$.label') = 'L0001' AND tombstoned_at IS NULL",
    ).get() as { content: string };
    expect(row.content).toBe('REVISED body');
  });
});
