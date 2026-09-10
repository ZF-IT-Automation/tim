import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  TimStore,
  resetDefaultEmbeddingProviderCache,
  validateEmbeddingModelId,
  vectorContentFingerprint,
  type EmbeddingProvider,
} from '../index.js';
import { embedUnembeddedEntries } from 'tim-hooks';
import { runMigrations, MIGRATIONS } from '../schema.js';
import { tim_import, createV2HmemDatabase } from 'tim-migrate';

const ENV_MODEL = 'all-MiniLM-L6-v2';
const CUSTOM_MODEL = 'test-injected-model-v1';
const DIM = 384;

function unitVector(values: number[]): Float32Array {
  const arr = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}

function makeCustomProvider(
  embedFn: (texts: string[]) => Promise<Float32Array[]>,
): EmbeddingProvider {
  return { modelId: CUSTOM_MODEL, dimension: DIM, state: 'enabled', embed: embedFn };
}

describe('correction gaps (#33 second pass)', () => {
  let dir: string;
  let store: TimStore;
  let provider: EmbeddingProvider;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-correction-'));
    delete process.env.TIM_EMBEDDING_DISABLED;
    delete process.env.TIM_EMBEDDING_MODEL;
    provider = makeCustomProvider(async (texts) =>
      texts.map(t => {
        const lower = t.toLowerCase();
        if (lower.includes('automobile')) return unitVector([0.9, 0.1, 0.05]);
        if (lower.includes('motor')) return unitVector([0.85, 0.15, 0.1]);
        if (lower.includes('python')) return unitVector([0.1, 0.9, 0.05]);
        return unitVector([0.3, 0.3, 0.3]);
      }),
    );
    store = new TimStore(path.join(dir, 'test.db'), { embeddingProvider: provider });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    resetDefaultEmbeddingProviderCache();
    delete process.env.TIM_EMBEDDING_DISABLED;
    delete process.env.TIM_EMBEDDING_MODEL;
  });

  it('rejects prototype model names via own-property validation', () => {
    expect(validateEmbeddingModelId('constructor')).toBe(false);
    expect(validateEmbeddingModelId('toString')).toBe(false);
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

  it('rejects invalid query embeddings and uses custom injected model identity', async () => {
    const badProvider = makeCustomProvider(async () => [new Float32Array(128)]);
    const badStore = new TimStore(path.join(dir, 'bad-embed.db'), {
      embeddingProvider: badProvider,
    });
    const entry = await badStore.write('Motor topic\nBody.', { tags: ['#x'] });
    badStore.setVectors(entry.id, unitVector([0.85, 0.15, 0.1]), CUSTOM_MODEL, DIM);

    const hits = await badStore.search({
      query: 'automobile',
      searchType: 'vector',
      topK: 3,
    });
    expect(hits).toEqual([]);
    expect(badStore.lastSearchSemantic?.vectorUnavailable).toBe(true);
    expect(badStore.lastSearchSemantic?.configuredModel).toBe(CUSTOM_MODEL);
    badStore.close();
  });

  it('ignores legacy empty content_hash rows in vector search', async () => {
    const entry = await store.write('Motor legacy hash\nVehicle note.', { tags: ['#legacy'] });
    const db = store.getDb();
    db.prepare(`
      INSERT INTO entry_vectors (entry_id, model, vector, content_hash)
      VALUES (?, ?, ?, '')
    `).run(
      entry.id,
      CUSTOM_MODEL,
      Buffer.from(unitVector([0.85, 0.15, 0.1]).buffer),
    );

    const hits = await store.search({
      query: 'automobile',
      searchType: 'vector',
      topK: 3,
    });
    expect(hits).toEqual([]);
    expect(await store.getUnembedded(10, CUSTOM_MODEL)).toContainEqual(
      expect.objectContaining({ id: entry.id }),
    );
  });

  it('CAS setVectors rejects stale expectedContentHash after edit', async () => {
    const entry = await store.write('Deferred motor topic\nOriginal meaning.', {
      tags: ['#cas'],
    });
    const fingerprint = vectorContentFingerprint(entry.title, entry.content);
    await store.update(entry.id, { content: 'Deferred motor topic\nEdited before store.' });

    const stored = store.setVectors(
      entry.id,
      unitVector([0.85, 0.15, 0.1]),
      CUSTOM_MODEL,
      DIM,
      fingerprint,
    );
    expect(stored).toBe(false);
    expect(store.getDb().prepare(
      'SELECT entry_id FROM entry_vectors WHERE entry_id = ?',
    ).get(entry.id)).toBeUndefined();

    store.setVectors(entry.id, unitVector([0.2, 0.8, 0.1]), CUSTOM_MODEL, DIM);
    const hits = await store.search({
      query: 'automobile',
      searchType: 'vector',
      topK: 1,
    });
    expect(hits[0]?.id).toBe(entry.id);
  });

  it('embedUnembeddedEntries keeps backlog when entry edits during embed await', async () => {
    const hookStoreRef: { current?: TimStore } = {};
    const slowProvider = makeCustomProvider(async (texts) => {
      const hookStore = hookStoreRef.current!;
      const pending = await hookStore.getUnembedded(1, CUSTOM_MODEL);
      if (pending[0]) {
        await hookStore.update(pending[0].id, {
          content: 'Deferred motor topic\nEdited during embed.',
        });
      }
      return texts.map(() => unitVector([0.85, 0.15, 0.1]));
    });
    const hookStore = new TimStore(path.join(dir, 'hook-cas.db'), {
      embeddingProvider: slowProvider,
    });
    hookStoreRef.current = hookStore;
    const entry = await hookStore.write('Deferred motor topic\nOriginal meaning.', {
      tags: ['#cas-hook'],
    });
    const count = await embedUnembeddedEntries(hookStore, { batchSize: 5 });
    expect(count).toBe(0);
    expect(await hookStore.getUnembedded(10, CUSTOM_MODEL)).toContainEqual(
      expect.objectContaining({ id: entry.id }),
    );
    hookStore.close();
  });

  it('embedUnembeddedEntries uses provider model and CAS fingerprint', async () => {
    const entry = await store.write('Hook motor topic\nNeeds embedding.', { tags: ['#hook'] });
    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBeGreaterThanOrEqual(1);
    const row = store.getDb().prepare(
      'SELECT model, content_hash FROM entry_vectors WHERE entry_id = ?',
    ).get(entry.id) as { model: string; content_hash: string };
    expect(row.model).toBe(CUSTOM_MODEL);
    expect(row.content_hash).toBe(vectorContentFingerprint(entry.title, entry.content));
  });

  it('hybrid ranks semantic-only candidate without FTS position penalty', async () => {
    const lexical = await store.write('HybridLexicalMarker Python tips\nTry/except body.', {
      tags: ['#python'],
    });
    const semantic = await store.write('ZzzUniqueNoLexicalOverlap\nEngine fault codes.', {
      tags: ['#cars'],
    });
    store.setVectors(semantic.id, unitVector([0.85, 0.15, 0.1]), CUSTOM_MODEL, DIM);
    store.setVectors(lexical.id, unitVector([0.1, 0.9, 0.05]), CUSTOM_MODEL, DIM);

    const hits = await store.search({
      query: 'python',
      topK: 2,
      searchType: 'hybrid',
    });
    expect(hits[0]?.id).toBe(lexical.id);
    expect(hits.map(h => h.id)).toContain(semantic.id);
  });

  it('health reports unknown before default provider init and injected model id', async () => {
    resetDefaultEmbeddingProviderCache();
    const bare = new TimStore(path.join(dir, 'bare.db'));
    const healthBefore = bare.getSemanticIndexHealth();
    expect(healthBefore.providerState).toBe('unknown');
    bare.close();

    const healthInjected = store.getSemanticIndexHealth();
    expect(healthInjected.providerState).toBe('enabled');
    expect(healthInjected.configuredModel).toBe(CUSTOM_MODEL);
  });

  it('v13->v14 migration leaves legacy vectors in reindex backlog', () => {
    const legacyPath = path.join(dir, 'legacy-v13.db');
    const db = new Database(legacyPath);
    runMigrations(db, MIGRATIONS.slice(0, -1));
    db.prepare(`
      INSERT INTO entries (id, content_type, content, tags, metadata, created_at, updated_at, accessed_at)
      VALUES ('legacy-entry', 'text', 'Motor legacy\nPre-v14 vector.', '[]', '{}',
        datetime('now'), datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO entry_vectors (entry_id, model, vector)
      VALUES ('legacy-entry', ?, ?)
    `).run(
      ENV_MODEL,
      Buffer.from(unitVector([0.85, 0.15, 0.1]).buffer),
    );
    db.close();

    const migrated = new TimStore(legacyPath, {
      allowMigrations: true,
      embeddingProvider: provider,
    });
    const cols = migrated.getDb().prepare("PRAGMA table_info('entry_vectors')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('content_hash');
    expect(migrated.getSemanticIndexHealth().unembeddedCount).toBeGreaterThanOrEqual(1);
    migrated.close();
  });

  it('hmem import invalidates device-local vectors for changed content', () => {
    const importDb = path.join(dir, 'import.db');
    const importStore = new TimStore(importDb, { embeddingProvider: provider });
    const hmemPath = path.join(dir, 'import.hmem');
    const rootUid = '01ROOT00000000000000000003';
    const db = createV2HmemDatabase(hmemPath);
    db.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned, tags)
      VALUES (?, 'L3502', 'L', 1, 'Imported motor', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
        0, 0, 0, 0, 0, '["#import"]')
    `).run(rootUid);
    db.close();

    tim_import(importStore, hmemPath);
    const imported = importStore.getDb().prepare(
      "SELECT id FROM entries WHERE title = 'Imported motor'",
    ).get() as { id: string };
    importStore.setVectors(imported.id, unitVector([0.85, 0.15, 0.1]), CUSTOM_MODEL, DIM);

    const db2 = createV2HmemDatabase(hmemPath);
    db2.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned, tags)
      VALUES (?, 'L3502', 'L', 1, 'Imported motor\nChanged imported body.', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z',
        0, 0, 0, 0, 0, '["#import"]')
    `).run(rootUid);
    db2.close();

    tim_import(importStore, hmemPath);

    expect(importStore.getDb().prepare(
      'SELECT entry_id FROM entry_vectors WHERE entry_id = ?',
    ).get(imported.id)).toBeUndefined();
    importStore.close();
  });
});

describe('default provider init dedup', () => {
  afterEach(() => {
    resetDefaultEmbeddingProviderCache();
    vi.resetModules();
  });

  it('concurrent getDefaultEmbeddingProvider shares one in-flight init', async () => {
    vi.resetModules();
    const initCount = { n: 0 };
    vi.doMock('fastembed', () => ({
      EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2' },
      FlagEmbedding: {
        init: vi.fn(async () => {
          initCount.n++;
          await new Promise(r => setTimeout(r, 20));
          return {
            embed: async function* () {
              yield [Array.from({ length: 384 }, () => 0.1)];
            },
          };
        }),
      },
    }));
    const { getDefaultEmbeddingProvider, resetDefaultEmbeddingProviderCache: reset } =
      await import('../embedding-provider.js');
    reset();
    const [a, b] = await Promise.all([
      getDefaultEmbeddingProvider('all-MiniLM-L6-v2'),
      getDefaultEmbeddingProvider('all-MiniLM-L6-v2'),
    ]);
    expect(a?.state).toBe('enabled');
    expect(b?.state).toBe('enabled');
    expect(initCount.n).toBe(1);
  });
});
