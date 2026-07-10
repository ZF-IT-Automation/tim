// TIM Store — tim_suppress enforcement tests (Plan 1, Task 1)
//
// Pattern stored by tim_suppress must actually hide entries from
// search() and loadProject(), otherwise the tool lies to agents.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('suppress enforcement', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-suppress-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('hides suppressed entries from search()', async () => {
    await store.write('Secret token rotation\nThe API key rotates weekly.');
    await store.write('Public docs page\nNothing sensitive here.');
    await store.suppress('token rotation', 'security');

    const results = await store.search({ query: 'rotation weekly' });
    expect(results.find(e => e.title.includes('Secret'))).toBeUndefined();

    const publicHit = await store.search({ query: 'docs page' });
    expect(publicHit.length).toBeGreaterThan(0);
  });

  it('hides suppressed entries (and their subtrees) from loadProject()', async () => {
    const project = await store.createProject('P9001', { content: 'P9001 Test' });
    const section = await store.write('Poison Section\nold approach', {
      parentId: project.id,
    });
    await store.write('Child of poison\ndetail', { parentId: section.id });
    await store.write('Clean Section\ngood stuff', { parentId: project.id });
    await store.suppress('old approach', 'deprecated');

    const result = await store.loadProject('P9001');
    expect(result).not.toBeNull();
    const titles = result!.children.map(c => c.title);
    expect(titles).toContain('Clean Section');
    expect(titles).not.toContain('Poison Section');
    expect(titles).not.toContain('Child of poison');
  });

  it('hides suppressed entries from read() when enforceSuppression is set', async () => {
    const entry = await store.write('Secret plan\nnuke the flag day');
    await store.suppress('nuke the flag', 'security');

    expect(await store.read(entry.id, { enforceSuppression: true })).toBeNull();
    // Management paths (no flag) still see it — suppressed content stays manageable.
    expect(await store.read(entry.id)).not.toBeNull();
  });

  it('filters suppressed children from read() with includeChildren', async () => {
    const parent = await store.write('Parent\nclean');
    await store.write('Bad child\npoisoned advice here', { parentId: parent.id });
    await store.write('Good child\nfine', { parentId: parent.id });
    await store.suppress('poisoned advice', 'wrong');

    const result = await store.read(parent.id, {
      includeChildren: true,
      depth: 2,
      enforceSuppression: true,
    });
    const titles = ((result as any).children as { title: string }[]).map(c => c.title);
    expect(titles).toContain('Good child');
    expect(titles).not.toContain('Bad child');
  });

  it('filters suppressed entries from getChildren() when enforceSuppression is set', async () => {
    const parent = await store.write('Section\n');
    await store.write('Hidden item\nlegacy hack pattern', { parentId: parent.id });
    await store.write('Visible item\nok', { parentId: parent.id });
    await store.suppress('legacy hack', 'deprecated');

    const enforced = await store.getChildren(parent.id, { enforceSuppression: true });
    expect(enforced.map(e => e.title)).toEqual(['Visible item']);
    // Without the flag both remain (management view).
    const raw = await store.getChildren(parent.id);
    expect(raw.length).toBe(2);
  });

  it('filterSuppressed() drops matching entries from arbitrary result sets', async () => {
    const a = await store.write('Alpha\nkeep me');
    const b = await store.write('Beta\ndrop this secret');
    await store.suppress('drop this secret', 'test');

    const filtered = store.filterSuppressed([a, b]);
    expect(filtered.map(e => e.id)).toEqual([a.id]);
  });

  it('expired suppress patterns do not hide entries', async () => {
    await store.write('Ephemeral thing\ntemporary content');
    // 1-minute TTL, then simulate expiry by rewriting expires_at into the past
    await store.suppress('temporary content', 'test', '1m');
    store.getDb().prepare(
      "UPDATE suppressed SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();

    const results = await store.search({ query: 'temporary content' });
    expect(results.length).toBeGreaterThan(0);
  });
});