import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import { isSecret, setSecretSubtree } from '../secret.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('secret nodes', () => {
  it('setSecretSubtree materializes flag on descendants', async () => {
    const root = await store.write('Root');
    const child = await store.write('Child', { parentId: root.id });
    const grand = await store.write('Grand', { parentId: child.id });

    const count = await setSecretSubtree(store, root.id);
    expect(count).toBe(3);

    const db = store.getDb();
    for (const id of [root.id, child.id, grand.id]) {
      const row = db.prepare('SELECT metadata FROM entries WHERE id = ?').get(id) as {
        metadata: string;
      };
      expect(JSON.parse(row.metadata).secret).toBe(true);
    }
  });

  it('create under secret parent inherits secret', async () => {
    const secret = await store.write('Secret root', { metadata: { secret: true } });
    const child = await store.write('Child under secret', { parentId: secret.id });

    expect(child.metadata.secret).toBe(true);
  });

  it('isSecret true for inherited descendant, false outside subtree', async () => {
    const secret = await store.write('Secret', { metadata: { secret: true } });
    const inside = await store.write('Inside', { parentId: secret.id });
    const outside = await store.write('Outside');

    const db = store.getDb();
    expect(isSecret(db, inside.id)).toBe(true);
    expect(isSecret(db, outside.id)).toBe(false);
  });

  it('secret entry absent from fts_entries; non-secret present', async () => {
    await store.write('Public searchable note', { id: 'PUBLIC-1' });
    await store.write('Hidden secret note', { id: 'SECRET-1', metadata: { secret: true } });

    const db = store.getDb();
    const publicFts = db
      .prepare('SELECT rowid FROM fts_entries WHERE title MATCH ?')
      .all('searchable') as { rowid: number }[];
    const secretFts = db
      .prepare('SELECT rowid FROM fts_entries WHERE title MATCH ?')
      .all('Hidden') as { rowid: number }[];

    expect(publicFts.length).toBeGreaterThan(0);
    expect(secretFts.length).toBe(0);
  });

  it('update non-secret to secret removes it from FTS', async () => {
    const entry = await store.write('Will become secret', { id: 'FLIP-1' });
    const db = store.getDb();

    let fts = db
      .prepare('SELECT rowid FROM fts_entries WHERE title MATCH ?')
      .all('become') as { rowid: number }[];
    expect(fts.length).toBeGreaterThan(0);

    await store.update(entry.id, { metadata: { secret: true } });

    fts = db
      .prepare('SELECT rowid FROM fts_entries WHERE title MATCH ?')
      .all('become') as { rowid: number }[];
    expect(fts.length).toBe(0);
  });
});
