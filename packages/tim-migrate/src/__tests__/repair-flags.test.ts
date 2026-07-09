// repairImportFlags — heals flag corruption from the 2026-05-30 migration

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore } from 'tim-store';
import { tim_import, repairImportFlags } from '../import.js';
import { createV2HmemDatabase } from '../hmem-format.js';

let store: TimStore;
let tmpDir: string;

beforeEach(() => {
  store = new TimStore(':memory:');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-repair-test-'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createFixture(filePath: string): string {
  const db = createV2HmemDatabase(filePath);
  const uid = '01REPAIR000000000000000001';
  db.prepare(`
    INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, obsolete, favorite, irrelevant, pinned, tags)
    VALUES (?, 'L0112', 'L', 112, 'Uberspace lesson', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
      0, 0, 1, 0, 0, '["#lesson"]')
  `).run(uid);
  db.close();
  return uid;
}

describe('repairImportFlags', () => {
  it('restores corrupted irrelevant/favorite flags and lost tags from source', () => {
    const filePath = path.join(tmpDir, 'src.hmem');
    const uid = createFixture(filePath);
    tim_import(store, filePath);

    // Simulate the 2026-05-30 corruption: flags inverted, tags lost.
    store.getDb().prepare(
      "UPDATE entries SET irrelevant = 1, favorite = 0, tags = '[]' WHERE id = ?",
    ).run(uid);

    const report = repairImportFlags(store, filePath);
    expect(report.matched).toBe(1);
    expect(report.repaired).toBe(1);

    const row = store.getDb().prepare(
      'SELECT irrelevant, favorite, tags FROM entries WHERE id = ?',
    ).get(uid) as { irrelevant: number; favorite: number; tags: string };
    expect(row.irrelevant).toBe(0);
    expect(row.favorite).toBe(1);
    expect(JSON.parse(row.tags)).toEqual(['#lesson']);

    // Repaired rows are staged so the fix propagates via sync.
    const staged = store.getDb().prepare(
      "SELECT COUNT(*) c FROM staging WHERE key = ? AND acked = 0",
    ).get(uid) as { c: number };
    expect(staged.c).toBeGreaterThan(0);
  });

  it('does not overwrite tags added in TIM after import, and dry-run changes nothing', () => {
    const filePath = path.join(tmpDir, 'src2.hmem');
    const uid = createFixture(filePath);
    tim_import(store, filePath);

    store.getDb().prepare(
      "UPDATE entries SET irrelevant = 1, tags = '[\"#added-later\"]' WHERE id = ?",
    ).run(uid);

    const dry = repairImportFlags(store, filePath, { dryRun: true });
    expect(dry.repaired).toBe(1);
    let row = store.getDb().prepare('SELECT irrelevant FROM entries WHERE id = ?')
      .get(uid) as { irrelevant: number };
    expect(row.irrelevant).toBe(1); // dry run: untouched

    repairImportFlags(store, filePath);
    const after = store.getDb().prepare('SELECT irrelevant, tags FROM entries WHERE id = ?')
      .get(uid) as { irrelevant: number; tags: string };
    expect(after.irrelevant).toBe(0);
    expect(JSON.parse(after.tags)).toEqual(['#added-later']); // TIM tags win
  });

  it('leaves entries alone that were deleted in the source', async () => {
    const filePath = path.join(tmpDir, 'src3.hmem');
    const uid = createFixture(filePath);
    tim_import(store, filePath);

    // Mark deleted in source, then flag in TIM — repair must not resurrect it.
    const Database = (await import('better-sqlite3')).default;
    const sdb = new Database(filePath);
    sdb.prepare("UPDATE entries SET deleted_at = '2026-03-01T00:00:00Z' WHERE uid = ?").run(uid);
    sdb.close();
    store.getDb().prepare('UPDATE entries SET irrelevant = 1 WHERE id = ?').run(uid);

    const report = repairImportFlags(store, filePath);
    expect(report.matched).toBe(0);
    expect(report.repaired).toBe(0);
    const row = store.getDb().prepare('SELECT irrelevant FROM entries WHERE id = ?')
      .get(uid) as { irrelevant: number };
    expect(row.irrelevant).toBe(1);
  });
});
