import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TimStore } from '../index.js';
import { runMigrations, MIGRATIONS } from '../schema.js';

describe('search correction gaps', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-correction-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lexical suppression scan survives >3*topK suppressed FTS hits', async () => {
    const topK = 2;
    for (let i = 0; i < 10; i++) {
      await store.write(`SuppNoise motor ${i}\nsecret needle token`, { tags: ['#noise'] });
    }
    const allowed = await store.write('Allowed motor topic\nClean vehicle note.', {
      tags: ['#allowed'],
    });
    await store.suppress('secret needle', 'test');

    const hits = await store.search({
      query: 'motor',
      topK,
      searchType: 'fts',
    });
    expect(hits.map(h => h.id)).toEqual([allowed.id]);
  });

  it('v13->v14 migration adds content_hash on the unused vectors table', () => {
    const legacyPath = path.join(dir, 'legacy-v13.db');
    const db = new Database(legacyPath);
    runMigrations(db, MIGRATIONS.slice(0, -1));
    db.close();

    const migrated = new TimStore(legacyPath, { allowMigrations: true });
    const cols = migrated.getDb().prepare("PRAGMA table_info('entry_vectors')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('content_hash');
    migrated.close();
  });
});
