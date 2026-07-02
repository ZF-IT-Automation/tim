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