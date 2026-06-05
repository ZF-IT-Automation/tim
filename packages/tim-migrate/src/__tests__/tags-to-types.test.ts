// Tests for tags-to-types migration
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from 'tim-store';
import { migrateTagsToTypes } from '../tags-to-types.js';
import type { MigrationEntryResult } from '../tags-to-types.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

function seedEntry(title: string, tags: string[], metadata: Record<string, unknown> = {}) {
  // Use raw SQL because TimStore's write() auto-generates ULIDs
  // and we want predictable IDs for assertions.
  const id = `test-${title.replace(/\s+/g, '-').toLowerCase()}`;
  const now = new Date().toISOString();
  store.getDb().prepare(`
    INSERT INTO entries (id, title, content, parent_id, depth, confidence,
      created_at, accessed_at, visibility, tags, metadata, irrelevant)
    VALUES (?, ?, '', NULL, 1, 1.0, ?, ?, 1, ?, ?, 0)
  `).run(id, title, now, now, JSON.stringify(tags), JSON.stringify(metadata));
}

function getEntry(id: string): { tags: string[]; metadata: Record<string, unknown> } | null {
  const row = store.getDb().prepare('SELECT tags, metadata FROM entries WHERE id = ?').get(id) as
    { tags: string; metadata: string } | undefined;
  if (!row) return null;
  return {
    tags: JSON.parse(row.tags),
    metadata: JSON.parse(row.metadata),
  };
}

describe('migrateTagsToTypes', () => {
  it('migrates entries with #rule tag', async () => {
    seedEntry('Rule 1', ['#rule']);
    seedEntry('Rule 2', ['#rule', '#other']);

    const report = await migrateTagsToTypes(store);

    expect(report.scanned).toBe(2);
    expect(report.migrated).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);

    const r1 = getEntry('test-rule-1')!;
    expect(r1.tags).toEqual([]); // #rule removed
    expect(r1.metadata.type).toBe('rule');

    const r2 = getEntry('test-rule-2')!;
    expect(r2.tags).toEqual(['#other']); // #rule removed, #other kept
    expect(r2.metadata.type).toBe('rule');
  });

  it('migrates entries with #human tag', async () => {
    seedEntry('Human 1', ['#human']);

    const report = await migrateTagsToTypes(store);

    expect(report.migrated).toBe(1);
    const entry = getEntry('test-human-1')!;
    expect(entry.tags).toEqual([]);
    expect(entry.metadata.type).toBe('human');
  });

  it('handles tags without leading #', async () => {
    seedEntry('Bare rule', ['rule']);
    seedEntry('Bare human', ['human']);

    const report = await migrateTagsToTypes(store);

    expect(report.migrated).toBe(2);
    const r = getEntry('test-bare-rule')!;
    expect(r.metadata.type).toBe('rule');
    expect(r.tags).toEqual([]);

    const h = getEntry('test-bare-human')!;
    expect(h.metadata.type).toBe('human');
  });

  it('handles whitespace and case variation', async () => {
    seedEntry('Padded', ['  #rule  ', '  #HUMAN  ']);
    seedEntry('Upper', ['#RULE']);

    const report = await migrateTagsToTypes(store);

    expect(report.migrated).toBe(2);
    const p = getEntry('test-padded')!;
    // First recognized tag is 'rule' (from '#rule'); multi-type → first wins.
    expect(p.metadata.type).toBe('rule');
    // Both recognized tags removed.
    expect(p.tags).toEqual([]);

    const u = getEntry('test-upper')!;
    expect(u.metadata.type).toBe('rule');
  });

  it('is idempotent (re-running does nothing)', async () => {
    seedEntry('Rule entry', ['#rule']);

    // First run: migrates.
    const r1 = await migrateTagsToTypes(store);
    expect(r1.migrated).toBe(1);
    expect(r1.skipped).toBe(0);

    // Second run: skips (already has metadata.type).
    const r2 = await migrateTagsToTypes(store);
    expect(r2.migrated).toBe(0);
    expect(r2.skipped).toBe(1);

    // Data unchanged.
    const entry = getEntry('test-rule-entry')!;
    expect(entry.metadata.type).toBe('rule');
    expect(entry.tags).toEqual([]);
  });

  it('skips entries without recognized tags', async () => {
    seedEntry('Note', ['#note', '#todo']);
    seedEntry('Checkpoint', ['#session-summary']);

    const report = await migrateTagsToTypes(store);

    expect(report.migrated).toBe(0);
    expect(report.skipped).toBe(2);

    const note = getEntry('test-note')!;
    expect(note.tags).toEqual(['#note', '#todo']);
    expect(note.metadata.type).toBeUndefined();
  });

  it('dry-run mode does not write changes', async () => {
    seedEntry('Rule entry', ['#rule', '#other']);

    const report = await migrateTagsToTypes(store, { dryRun: true });
    expect(report.migrated).toBe(1);

    // Entry should be unchanged because it was a dry run.
    const entry = getEntry('test-rule-entry')!;
    expect(entry.tags).toEqual(['#rule', '#other']);
    expect(entry.metadata.type).toBeUndefined();
  });

  it('includes sampleChanges in report', async () => {
    seedEntry('Rule 1', ['#rule']);
    seedEntry('Human 1', ['#human']);
    seedEntry('Note', ['#note']);

    const report = await migrateTagsToTypes(store, { sampleLimit: 2 });

    expect(report.sampleChanges.length).toBe(2);
    const ruleChange = report.sampleChanges.find(c => c.typeSet === 'rule')!;
    expect(ruleChange).toBeDefined();
    expect(ruleChange.oldTags).toContain('#rule');
    expect(ruleChange.newTags).not.toContain('#rule');
    expect(ruleChange.changed).toBe(true);
  });

  it('ignores already-migrated + still-tagged entries', async () => {
    // Edge case: entry was migrated, then a bug re-added the tag.
    // Should be skipped because metadata.type is already set.
    seedEntry('Already migrated', [], { type: 'rule' });
    // Direct SQL to add tag back (simulating bug).
    store.getDb().prepare(
      'UPDATE entries SET tags = ? WHERE id = ?',
    ).run(JSON.stringify(['#rule']), 'test-already-migrated');

    const report = await migrateTagsToTypes(store);

    expect(report.migrated).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it('handles empty database', async () => {
    const report = await migrateTagsToTypes(store);
    expect(report.scanned).toBe(0);
    expect(report.migrated).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.sampleChanges).toEqual([]);
  });
});
