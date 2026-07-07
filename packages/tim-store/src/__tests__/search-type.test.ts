import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimStore } from '../store.js';

describe('search searchType', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it('searchType fts skips fastembed even when vectors exist', async () => {
    const entry = await store.write('embedding topic alpha', {
      tags: ['#alpha'],
      metadata: { kind: 'lesson' },
    });

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare(`
      INSERT INTO entry_vectors (entry_id, vector, model)
      VALUES (?, ?, 'all-MiniLM-L6-v2')
    `).run(entry.id, Buffer.from(new Float32Array([1, 0, 0]).buffer));

    const fastembed = await import('fastembed');
    const initSpy = vi.spyOn(fastembed.FlagEmbedding, 'init');

    const results = await store.search({
      query: 'alpha embedding',
      topK: 5,
      searchType: 'fts',
    });

    expect(initSpy).not.toHaveBeenCalled();
    expect(results.some(r => r.id === entry.id)).toBe(true);
  });
});
