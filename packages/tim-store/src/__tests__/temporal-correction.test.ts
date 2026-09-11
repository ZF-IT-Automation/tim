import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';
import {
  hasSupersedesPath,
  registerTemporalSqlFunctions,
  validateSupersessionLink,
} from '../temporal.js';

describe('temporal correction (#36 second pass)', () => {
  let dir: string;
  let store: TimStore;
  let projectId: string;
  let sectionId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-temporal-correction-'));
    store = new TimStore(path.join(dir, 'test.db'));
    const project = await store.createProject('P3700', { content: 'Temporal correction', memoryOnly: true });
    projectId = project.id;
    const section = await store.write('Decisions', {
      parentId: projectId,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    sectionId = section.id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function writeDecision(title: string, body: string, metadata?: Record<string, unknown>) {
    return store.write(`${title}\n${body}`, {
      parentId: sectionId,
      tags: ['#decision', '#note'],
      metadata: {
        evidence: { authority: 'user_asserted', sources: [] },
        ...metadata,
      },
    });
  }

  function snapshotEntry(id: string) {
    return store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(id);
  }

  function snapshotEdges() {
    return store.getDb().prepare('SELECT * FROM edges').all();
  }

  function snapshotStaging() {
    return store.getDb().prepare('SELECT * FROM staging').all();
  }

  it('validates the combined interval when a patch contains only one boundary', async () => {
    const entry = await writeDecision('Bounded policy', 'Body', {
      temporal: { validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-06-01T00:00:00Z' },
    });
    const before = snapshotEntry(entry.id);
    const staging = snapshotStaging();
    await expect(store.update(entry.id, {
      metadata: { temporal: { validFrom: '2026-07-01T00:00:00Z' } },
    })).rejects.toThrow(/strictly before/);
    await expect(store.update(entry.id, {
      metadata: { temporal: { validUntil: '2025-12-01T00:00:00Z' } },
    })).rejects.toThrow(/strictly before/);
    expect(snapshotEntry(entry.id)).toEqual(before);
    expect(snapshotStaging()).toEqual(staging);
  });

  it('detects supersession cycles beyond the old 32-node cap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 35; i++) {
      ids.push((await writeDecision(`D${i}`, `Body ${i}`)).id);
    }
    for (let i = 1; i < ids.length; i++) {
      await store.link(ids[i], ids[i - 1], 'supersedes', 1.0, {
        effectiveAt: new Date(Date.UTC(2026, 0, i)).toISOString(),
      });
    }

    const db = store.getDb();
    expect(hasSupersedesPath(db, ids[34], ids[0])).toBe(true);

    const bad = await store.link(ids[0], ids[34], 'supersedes', 1.0, {
      effectiveAt: '2026-12-01T00:00:00Z',
    }).catch(err => err);
    expect(bad).toBeInstanceOf(Error);
    expect(String(bad)).toMatch(/cycle/);
  });

  it('leaves entries, edges and staging unchanged when supersession validation fails', async () => {
    const source = await writeDecision('Source', 'Replacement');
    const target = await writeDecision('Target', 'Original');
    const beforeSource = snapshotEntry(source.id);
    const beforeTarget = snapshotEntry(target.id);
    const edgesBefore = snapshotEdges();
    const stagingBefore = snapshotStaging();

    await expect(store.link(source.id, target.id, 'supersedes', 1.0, {
      effectiveAt: '2026-02-31T00:00:00Z',
    })).rejects.toThrow();

    expect(snapshotEntry(source.id)).toEqual(beforeSource);
    expect(snapshotEntry(target.id)).toEqual(beforeTarget);
    expect(snapshotEdges()).toEqual(edgesBefore);
    expect(snapshotStaging()).toEqual(stagingBefore);
  });

  it('rejects supersession when replacement is not yet valid at effectiveAt', async () => {
    const source = await writeDecision('Future source', 'Not yet valid', {
      temporal: { validFrom: '2026-12-01T00:00:00Z' },
    });
    const target = await writeDecision('Target', 'Old');
    await expect(store.link(source.id, target.id, 'supersedes', 1.0, {
      effectiveAt: '2026-03-15T12:00:00Z',
    })).rejects.toThrow(/not valid at effectiveAt/);
  });

  it('preserves managed supersession fields on partial temporal metadata updates', async () => {
    const old = await writeDecision('Old', 'Body');
    const replacement = await writeDecision('New', 'Body');
    await store.link(replacement.id, old.id, 'supersedes', 1.0, {
      effectiveAt: '2026-03-15T12:00:00Z',
    });

    await store.update(old.id, {
      metadata: {
        temporal: { validUntil: '2026-03-15T12:00:00.000Z' },
      },
    });

    const row = snapshotEntry(old.id) as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.temporal.supersededBy).toBe(replacement.id);
    expect(meta.temporal.supersededAt).toBe('2026-03-15T12:00:00.000Z');
  });

  it('rejects empty temporal patches that would revive superseded entries', async () => {
    const old = await writeDecision('Old', 'Body');
    const replacement = await writeDecision('New', 'Body');
    await store.link(replacement.id, old.id, 'supersedes', 1.0, {
      effectiveAt: '2026-03-15T12:00:00Z',
    });

    await expect(store.update(old.id, { metadata: { temporal: {} } })).rejects.toThrow(
      /cannot clear supersession state/,
    );
  });

  it('compares equivalent asOf timestamps through SQL epoch filtering in FTS search', async () => {
    const old = await writeDecision('Boundary policy', 'Use v1');
    const replacement = await writeDecision('Boundary policy v2', 'Use v2');
    await store.link(replacement.id, old.id, 'supersedes', 1.0, {
      effectiveAt: '2026-03-15T12:00:00Z',
    });

    store.getDb().prepare(`
      UPDATE entries
      SET metadata = json_set(metadata, '$.temporal.supersededAt', '2026-03-15T12:00:00+00:00')
      WHERE id = ?
    `).run(old.id);
    store.getDb().prepare(`
      UPDATE entries
      SET metadata = json_set(metadata, '$.temporal.validFrom', '2026-03-15T12:00:00.000Z')
      WHERE id = ?
    `).run(replacement.id);

    const asBefore = await store.search({
      query: 'Boundary policy',
      project: 'P3700',
      searchType: 'fts',
      asOf: '2026-03-15T11:59:59.000Z',
      topK: 5,
    });
    const asAt = await store.search({
      query: 'Boundary policy',
      project: 'P3700',
      searchType: 'fts',
      asOf: '2026-03-15T14:00:00+02:00',
      topK: 5,
    });

    expect(asBefore.map(e => e.id)).toContain(old.id);
    expect(asBefore.map(e => e.id)).not.toContain(replacement.id);
    expect(asAt.map(e => e.id)).toContain(replacement.id);
    expect(asAt.map(e => e.id)).not.toContain(old.id);
  });
});

describe('registerTemporalSqlFunctions', () => {
  it('parses peer/import ISO variants to the same epoch', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sql-fn-')), 'fn.db');
    const store = new TimStore(dbPath);
    registerTemporalSqlFunctions(store.getDb());
    const row = store.getDb().prepare(`
      SELECT tim_iso_to_epoch_ms(?) AS z,
             tim_iso_to_epoch_ms(?) AS millis,
             tim_iso_to_epoch_ms(?) AS offset
    `).get(
      '2026-03-15T12:00:00Z',
      '2026-03-15T12:00:00.000Z',
      '2026-03-15T14:00:00+02:00',
    ) as { z: number; millis: number; offset: number };
    expect(row.z).toBe(row.millis);
    expect(row.z).toBe(row.offset);
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

describe('validateSupersessionLink branching graph', () => {
  it('detects cycles through branching supersession graphs', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tim-branch-')), 'branch.db');
    const store = new TimStore(dbPath);
    const db = store.getDb();
    registerTemporalSqlFunctions(db);

    const insertEntry = (id: string) => {
      db.prepare(`
        INSERT INTO entries (id, content, content_type, depth, confidence, created_at, accessed_at, updated_at, tags, metadata)
        VALUES (?, ?, 'text', 1, 1.0, datetime('now'), datetime('now'), datetime('now'), '[]', '{}')
      `).run(id, 'body');
    };
    const ids = ['A', 'B', 'C', 'D'];
    for (const id of ids) insertEntry(id);
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type) VALUES ('e1', 'B', 'A', 'supersedes')`).run();
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type) VALUES ('e2', 'C', 'A', 'supersedes')`).run();
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type) VALUES ('e3', 'D', 'B', 'supersedes')`).run();
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type) VALUES ('e4', 'D', 'C', 'supersedes')`).run();

    const err = validateSupersessionLink({
      db,
      sourceId: 'A',
      targetId: 'D',
      effectiveAt: '2026-03-15T12:00:00Z',
      getProjectLabel: () => 'P3700',
      readRow: (id) => db.prepare('SELECT id, metadata FROM entries WHERE id = ?').get(id) as
        | { id: string; metadata: string }
        | undefined,
    });
    expect(err).toMatch(/cycle/);
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});
