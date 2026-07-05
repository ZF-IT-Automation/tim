import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('entry_vectors table', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migration v10 creates entry_vectors with correct schema', () => {
    const db = store.getDb();
    const cols = db.prepare("PRAGMA table_info('entry_vectors')").all() as Array<{
      name: string; type: string;
    }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('entry_id');
    expect(names).toContain('model');
    expect(names).toContain('vector');
  });

  it('getUnembedded returns entries without vectors, newest content first', async () => {
    const a = await store.write('Entry A\nContent.', { tags: ['#a', '#b'] });
    const b = await store.write('Entry B\nContent.', { tags: ['#a', '#b'] });

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.length).toBe(2);
    expect(unembedded[0].id).toBe(b.id); // newest first
  });

  it('getUnembedded skips schema kinds', async () => {
    await store.write('Session entry', { metadata: { kind: 'session' } });
    const unembedded = await store.getUnembedded(10);
    expect(unembedded).toEqual([]);
  });

  it('getUnembedded skips entries that already have vectors', async () => {
    const a = await store.write('Entry A\nContent.', { tags: ['#a', '#b'] });
    store.setVectors(a.id, new Float32Array(384), 'all-MiniLM-L6-v2');

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.find(e => e.id === a.id)).toBeUndefined();
  });

  it('setVectors upserts (second call replaces)', () => {
    store.getDb().prepare("INSERT INTO entries (id, content_type, content, tags, metadata, created_at, updated_at, accessed_at) VALUES ('test-vector-upsert', 'text', 'hello', '[]', '{}', datetime('now'), datetime('now'), datetime('now'))").run();
    store.setVectors('test-vector-upsert', new Float32Array(384), 'model-A');
    store.setVectors('test-vector-upsert', new Float32Array(768), 'model-B');

    const row = store.getDb().prepare(
      'SELECT model, length(vector) as len FROM entry_vectors WHERE entry_id = ?',
    ).get('test-vector-upsert') as { model: string; len: number };
    expect(row.model).toBe('model-B');
    // Float32Array(768) => 768 × 4 bytes = 3072
    expect(row.len).toBe(3072);
  });

  it('entry_vectors never enters staging', async () => {
    const a = await store.write('Entry A\nContent.', { tags: ['#a', '#b'] });
    const cursor = await store.getStagingCursor();
    store.setVectors(a.id, new Float32Array(384), 'test-model');
    expect(await store.getStagingCursor()).toBe(cursor);
  });
});
