import { describe, it, expect, afterEach } from 'vitest';
import { TimStore } from '../store.js';

let store: TimStore | null = null;
afterEach(() => { store?.close(); store = null; });

describe('health severity', () => {
  it('returns OK for a fresh database', async () => {
    store = new TimStore(':memory:');
    const health = await store.health();
    expect(health.status).toBe('OK');
    expect(health.blockers).toEqual([]);
    expect(health.warnings).toEqual([]);
  });

  it('returns WARN for broken links or orphans', async () => {
    store = new TimStore(':memory:');
    const parent = await store.write('Parent');
    const child = await store.write('Child', { parentId: parent.id });
    store.getDb().prepare('UPDATE entries SET parent_id = ? WHERE id = ?').run('missing-parent', child.id);
    const health = await store.health();
    expect(health.status).toBe('WARN');
    expect(health.warnings.join('\n')).toMatch(/orphan/i);
  });

  it('returns BLOCKER when the FTS integrity check fails', async () => {
    store = new TimStore(':memory:');
    store.getDb().exec('DROP TABLE IF EXISTS fts_entries');
    const health = await store.health();
    expect(health.status).toBe('BLOCKER');
    expect(health.blockers).toEqual(['FTS5 index integrity failure']);
    expect(health.warnings).toEqual([]);
  });
});
