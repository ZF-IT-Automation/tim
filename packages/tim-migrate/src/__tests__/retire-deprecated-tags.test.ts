import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from 'tim-store';
import { migrateRetireDeprecatedTags } from '../retire-deprecated-tags.js';

describe('migrateRetireDeprecatedTags', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function seedLegacyTags(id: string, tags: string[], kind?: string) {
    const now = new Date().toISOString();
    store.getDb().prepare(`
      INSERT INTO entries (id, title, content, tags, metadata, created_at, accessed_at, irrelevant)
      VALUES (?, ?, '', ?, ?, ?, ?, 0)
    `).run(id, 'Tagged', JSON.stringify(tags), JSON.stringify(kind ? { kind } : {}), now, now);
  }

  it('strips retired structural tags and keeps #session-summary', async () => {
    seedLegacyTags('legacy-1', ['#exchange', '#sessions', '#session-summary'], 'exchange');
    const report = await migrateRetireDeprecatedTags(store, { dryRun: false });
    expect(report.migrated).toBe(1);
    const read = await store.read('legacy-1');
    expect(read!.tags).toEqual(['#session-summary']);
  });

  it('leaves a structural tag alone on a node outside the session tree', async () => {
    // Measured on the live database before this scoping existed: an hmem-era note carried
    // #checkpoint as subject matter. An unscoped sweep deleted it.
    seedLegacyTags('content-1', ['#hmem', '#checkpoint', '#mcp']);
    const report = await migrateRetireDeprecatedTags(store, { dryRun: false });
    expect(report.migrated).toBe(0);
    const read = await store.read('content-1');
    expect(read!.tags).toEqual(['#hmem', '#checkpoint', '#mcp']);
  });

  it('strips status and priority tags on any node, session tree or not', async () => {
    seedLegacyTags('legacy-3', ['#todo', '#priority-high', '#architecture']);
    const report = await migrateRetireDeprecatedTags(store, { dryRun: false });
    expect(report.migrated).toBe(1);
    expect(report.sampleChanges[0].removed).toEqual(['#todo', '#priority-high']);
    const read = await store.read('legacy-3');
    expect(read!.tags).toEqual(['#architecture']);
  });

  it('dry-run does not modify rows', async () => {
    seedLegacyTags('legacy-2', ['#exchange', '#session-summary'], 'exchange');
    const report = await migrateRetireDeprecatedTags(store, { dryRun: true });
    expect(report.migrated).toBe(1);
    const row = store.getDb().prepare('SELECT tags FROM entries WHERE id = ?').get('legacy-2') as {
      tags: string;
    };
    expect(JSON.parse(row.tags)).toEqual(['#exchange', '#session-summary']);
  });
});
