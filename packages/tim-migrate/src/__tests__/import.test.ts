// Import tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { TimStore } from 'tim-store';
import { tim_import } from '../import.js';
import { createV2HmemDatabase } from '../hmem-format.js';

let store: TimStore;
let tmpDir: string;

beforeEach(() => {
  store = new TimStore(':memory:');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-import-test-'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createV2Fixture(filePath: string): { rootUid: string; childUid: string } {
  const db = createV2HmemDatabase(filePath);
  const rootUid = '01ROOT00000000000000000001';
  const childUid = '01CHILD0000000000000000001';
  const otherUid = '01OTHER0000000000000000001';

  db.prepare(`
    INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, obsolete, favorite, irrelevant, pinned, tags)
    VALUES (?, 'P0001', 'P', 1, 'Imported root', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
      0, 0, 1, 0, 0, '["#project"]')
  `).run(rootUid);

  db.prepare(`
    INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, obsolete, favorite, irrelevant, pinned, tags)
    VALUES (?, 'L0001', 'L', 1, 'Other root', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
      0, 0, 0, 0, 0, '[]')
  `).run(otherUid);

  db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES (?, ?, NULL, 2, 1, 'Imported child', '["#detail"]',
      '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run(childUid, rootUid);

  db.prepare(`
    INSERT INTO links (src_uid, dst_uid, kind) VALUES (?, ?, 'relates')
  `).run(rootUid, otherUid);

  db.close();
  return { rootUid, childUid };
}

function createOldFixture(filePath: string): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      level_1 TEXT NOT NULL,
      level_2 TEXT,
      level_3 TEXT,
      level_4 TEXT,
      level_5 TEXT,
      last_accessed TEXT,
      links TEXT,
      obsolete INTEGER DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      irrelevant INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      updated_at TEXT
    );
  `);

  db.prepare(`
    INSERT INTO memories (id, prefix, seq, created_at, level_1, level_2, links, favorite)
    VALUES ('P0042', 'P', 42, '2026-01-01T00:00:00Z', 'Old root', 'Old child', '["L0001"]', 1)
  `).run();

  db.prepare(`
    INSERT INTO memories (id, prefix, seq, created_at, level_1)
    VALUES ('L0001', 'L', 1, '2026-01-01T00:00:00Z', 'Link target')
  `).run();

  db.close();
}

describe('tim_import', () => {
  it('imports v2 hmem with entries, nodes, and links', () => {
    const filePath = path.join(tmpDir, 'v2.hmem');
    const { rootUid, childUid } = createV2Fixture(filePath);

    const report = tim_import(store, filePath);
    expect(report.format).toBe('v2');
    expect(report.entriesImported).toBe(2);
    expect(report.nodesImported).toBe(1);
    expect(report.edgesImported).toBe(1);

    const root = store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(rootUid) as {
      title: string;
      content: string;
      metadata: string;
    };
    expect(root.title).toBe('Imported root');
    expect(root.content).toBe('');

    const meta = JSON.parse(root.metadata);
    expect(meta.label).toBe('P0001');
    expect(meta.hmemUid).toBe(rootUid);

    const child = store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(childUid) as {
      parent_id: string;
      title: string;
      content: string;
    };
    expect(child.parent_id).toBe(rootUid);
    expect(child.title).toBe('Imported child');
    expect(child.content).toBe('');
  });

  it('imports old hmem format with level hierarchy and links', () => {
    const filePath = path.join(tmpDir, 'old.hmem');
    createOldFixture(filePath);

    const report = tim_import(store, filePath);
    expect(report.format).toBe('old');
    expect(report.entriesImported).toBe(2);
    expect(report.nodesImported).toBe(1);
    expect(report.edgesImported).toBe(1);

    const root = store.getDb().prepare(
      "SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0042'",
    ).get() as { id: string };
    expect(root.id).toBe('P0042');

    const children = store.getDb().prepare(
      'SELECT title, content FROM entries WHERE parent_id = ?',
    ).all(root.id) as { title: string; content: string }[];
    expect(children[0].title).toBe('Old child');
    expect(children[0].content).toBe('');
  });

  it('dry run reports counts without writing', async () => {
    const filePath = path.join(tmpDir, 'dry.hmem');
    createV2Fixture(filePath);

    const before = (store.getDb().prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }).c;
    const report = tim_import(store, filePath, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.newCount).toBeGreaterThan(0);
    const after = (store.getDb().prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('deduplicates by label and merges instead of creating duplicate roots', async () => {
    await store.write('Existing', {
      metadata: { label: 'P0001', prefix: 'P', seq: 1 },
    });

    const filePath = path.join(tmpDir, 'dedup.hmem');
    createV2Fixture(filePath);

    const report = tim_import(store, filePath, { deduplicate: true });
    expect(report.conflicts.some(c => c.label === 'P0001' && c.action === 'merged')).toBe(true);

    const roots = store.getDb().prepare(
      "SELECT id FROM entries WHERE parent_id IS NULL AND json_extract(metadata, '$.label') = 'P0001'",
    ).all() as { id: string }[];
    expect(roots).toHaveLength(1);
  });

  it('remaps IDs on collision when deduplicate is false', async () => {
    const filePath = path.join(tmpDir, 'remap.hmem');
    const { rootUid } = createV2Fixture(filePath);

    await store.write('Pre-existing with same id', { id: rootUid });

    const report = tim_import(store, filePath, { deduplicate: false });
    expect(report.remapped).toBeGreaterThan(0);
    expect(report.conflicts.some(c => c.action === 'remapped')).toBe(true);

    const imported = store.getDb().prepare(
      "SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0001'",
    ).get() as { id: string };
    expect(imported.id).not.toBe(rootUid);
  });

  it('re-import skips already-migrated entries by hmemUid', async () => {
    const filePath = path.join(tmpDir, 'idempotent.hmem');
    createV2Fixture(filePath);

    // First import
    const first = tim_import(store, filePath);
    expect(first.entriesImported).toBe(2);
    expect(first.nodesImported).toBe(1);

    // Second import — should skip ALL because hmemUid already exists
    const second = tim_import(store, filePath);
    expect(second.entriesImported).toBe(0);
    expect(second.nodesImported).toBe(0);
    expect(second.skipped).toBe(3); // 2 entries + 1 node
    expect(second.conflicts.every(c => c.action === 'merged')).toBe(true);

    // No duplicates in store
    const rows = store.getDb().prepare(
      "SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0001'",
    ).all() as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it('force option bypasses idempotency guard', async () => {
    const filePath = path.join(tmpDir, 'force.hmem');
    createV2Fixture(filePath);

    // First import
    const first = tim_import(store, filePath);
    expect(first.entriesImported).toBe(2);

    const countBefore = (store.getDb().prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }).c;

    // Second import with force=true
    const second = tim_import(store, filePath, { force: true });
    expect(second.entriesImported).toBeGreaterThan(0);

    const countAfter = (store.getDb().prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }).c;
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

describe('tim_import — node rescue and mid-gen old format', () => {
  it('reattaches v2 nodes under a deleted parent to the nearest live ancestor', () => {
    const filePath = path.join(tmpDir, 'v2-deleted-parent.hmem');
    const db = createV2HmemDatabase(filePath);
    const rootUid = '01ROOTDEL00000000000000001';
    db.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned, tags)
      VALUES (?, 'P0010', 'P', 10, 'Root', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        0, 0, 0, 0, 0, '[]')
    `).run(rootUid);
    const insNode = db.prepare(`
      INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
        created_at, updated_at, irrelevant, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, ?)
    `);
    insNode.run('01NODELIVE0000000000000001', rootUid, null, 2, 1, 'Live parent', null);
    insNode.run('01NODEDEAD0000000000000001', rootUid, '01NODELIVE0000000000000001', 3, 1, 'Deleted middle', '2026-02-01T00:00:00Z');
    insNode.run('01NODEKID00000000000000001', rootUid, '01NODEDEAD0000000000000001', 4, 1, 'Orphaned child', null);
    db.close();

    const report = tim_import(store, filePath);
    expect(report.nodesImported).toBe(2); // live parent + rescued child, NOT the deleted one
    expect(report.warnings).toHaveLength(0);

    const kid = store.getDb().prepare('SELECT parent_id FROM entries WHERE id = ?')
      .get('01NODEKID00000000000000001') as { parent_id: string };
    expect(kid.parent_id).toBe('01NODELIVE0000000000000001');
    const dead = store.getDb().prepare('SELECT id FROM entries WHERE id = ?')
      .get('01NODEDEAD0000000000000001');
    expect(dead).toBeUndefined();
  });

  it('imports v2 nodes whose ordering puts them before their parent', () => {
    const filePath = path.join(tmpDir, 'v2-out-of-order.hmem');
    const db = createV2HmemDatabase(filePath);
    const rootUid = '01ROOTOOO00000000000000001';
    db.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned, tags)
      VALUES (?, 'P0011', 'P', 11, 'Root', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        0, 0, 0, 0, 0, '[]')
    `).run(rootUid);
    const insNode = db.prepare(`
      INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
        created_at, updated_at, irrelevant, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, NULL)
    `);
    // Child sorts BEFORE its parent: same depth, lower seq.
    insNode.run('01NODECHILD000000000000001', rootUid, '01NODEPARENT00000000000001', 2, 1, 'Child first');
    insNode.run('01NODEPARENT00000000000001', rootUid, null, 2, 2, 'Parent second');
    db.close();

    const report = tim_import(store, filePath);
    expect(report.nodesImported).toBe(2);
    expect(report.warnings).toHaveLength(0);
    const kid = store.getDb().prepare('SELECT parent_id FROM entries WHERE id = ?')
      .get('01NODECHILD000000000000001') as { parent_id: string };
    expect(kid.parent_id).toBe('01NODEPARENT00000000000001');
  });

  it('imports old-format memory_nodes and memory_tags', () => {
    const filePath = path.join(tmpDir, 'old-midgen.hmem');
    const db = new Database(filePath);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, prefix TEXT NOT NULL, seq INTEGER NOT NULL,
        created_at TEXT NOT NULL, level_1 TEXT NOT NULL,
        level_2 TEXT, level_3 TEXT, level_4 TEXT, level_5 TEXT,
        last_accessed TEXT, links TEXT, obsolete INTEGER DEFAULT 0,
        favorite INTEGER DEFAULT 0, irrelevant INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0, updated_at TEXT
      );
      CREATE TABLE memory_nodes (
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL,
        depth INTEGER NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, favorite INTEGER DEFAULT 0,
        irrelevant INTEGER DEFAULT 0, updated_at TEXT
      );
      CREATE TABLE memory_tags (entry_id TEXT NOT NULL, tag TEXT NOT NULL);
    `);
    db.prepare(`INSERT INTO memories (id, prefix, seq, created_at, level_1)
      VALUES ('P0052', 'P', 52, '2026-01-01T00:00:00Z', 'Company root')`).run();
    db.prepare(`INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at, irrelevant)
      VALUES ('P0052.1', 'P0052', 'P0052', 2, 1, 'Overview', '2026-01-01T00:00:00Z', 0)`).run();
    db.prepare(`INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at, irrelevant)
      VALUES ('P0052.1.1', 'P0052.1', 'P0052', 3, 1, 'Nested detail', '2026-01-01T00:00:00Z', 1)`).run();
    db.prepare(`INSERT INTO memory_tags (entry_id, tag) VALUES ('P0052', '#company')`).run();
    db.close();

    const report = tim_import(store, filePath);
    expect(report.format).toBe('old');
    expect(report.entriesImported).toBe(1);
    expect(report.nodesImported).toBe(2);

    const root = store.getDb().prepare('SELECT id, tags FROM entries WHERE id = ?')
      .get('P0052') as { id: string; tags: string };
    expect(JSON.parse(root.tags)).toContain('#company');

    const nested = store.getDb().prepare('SELECT parent_id, irrelevant FROM entries WHERE id = ?')
      .get('P0052.1.1') as { parent_id: string; irrelevant: number };
    expect(nested.parent_id).toBe('P0052.1');
    expect(nested.irrelevant).toBe(1);
  });
});
