import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TimStore,
  cosineSimilarity,
  createDisabledEmbeddingProvider,
  createUnavailableEmbeddingProvider,
  embeddingText,
  resetDefaultEmbeddingProviderCache,
  type EmbeddingProvider,
} from '../index.js';
import { applyRemoteEntry } from '../sync-methods.js';

const MODEL = 'all-MiniLM-L6-v2';
const DIM = 384;

function unitVector(values: number[]): Float32Array {
  const arr = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}

function makeTestProvider(
  embedFn: (texts: string[]) => Promise<Float32Array[]>,
  state: EmbeddingProvider['state'] = 'enabled',
): EmbeddingProvider {
  return { modelId: MODEL, dimension: DIM, state, embed: embedFn };
}

describe('semantic retrieval (#33)', () => {
  let dir: string;
  let store: TimStore;
  let provider: EmbeddingProvider;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-semantic-'));
    delete process.env.TIM_EMBEDDING_DISABLED;
    provider = makeTestProvider(async (texts) =>
      texts.map(t => {
        const lower = t.toLowerCase();
        if (lower.includes('automobile') || lower.includes('car concept')) {
          return unitVector([0.9, 0.1, 0.05]);
        }
        if (lower.includes('vehicle') || lower.includes('motor')) {
          return unitVector([0.85, 0.15, 0.1]);
        }
        if (lower.includes('python')) return unitVector([0.1, 0.9, 0.05]);
        if (lower.includes('javascript')) return unitVector([0.05, 0.1, 0.9]);
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

  it('recalls no-overlap synonym purely via vector search', async () => {
    const entry = await store.write('Motor transport notes\nUses internal combustion.', {
      tags: ['#transport'],
    });
    store.setVectors(
      entry.id,
      unitVector([0.85, 0.15, 0.1]),
      MODEL,
      DIM,
    );

    const hits = await store.search({
      query: 'automobile',
      topK: 3,
      searchType: 'vector',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(entry.id);
  });

  it('hybrid merges independent lexical and vector candidates', async () => {
    const lexical = await store.write('HybridLexicalMarker Python tips\nTry/except body.', {
      tags: ['#python'],
    });
    const semantic = await store.write('ZzzUniqueNoLexicalOverlap\nEngine fault codes.', {
      tags: ['#cars'],
    });
    store.setVectors(semantic.id, unitVector([0.85, 0.15, 0.1]), MODEL, DIM);

    const hits = await store.search({
      query: 'HybridLexicalMarker',
      topK: 5,
      searchType: 'hybrid',
    });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(lexical.id);
    expect(ids).toContain(semantic.id);
  });

  it('scopes vector candidates before topK and respects suppression', async () => {
    const p1 = await store.createProject('P1001', { content: 'Scope one' });
    const p2 = await store.createProject('P1002', { content: 'Scope two' });
    const inScope = await store.write('Motor secret scope\nScoped vehicle note.', {
      parentId: p1.id,
      tags: ['#scope'],
    });
    const foreign = await store.write('Motor foreign scope\nForeign vehicle note.', {
      parentId: p2.id,
      tags: ['#scope'],
    });
    store.setVectors(inScope.id, unitVector([0.85, 0.15, 0.1]), MODEL, DIM);
    store.setVectors(foreign.id, unitVector([0.85, 0.15, 0.1]), MODEL, DIM);

    const hits = await store.search({
      query: 'automobile',
      topK: 5,
      searchType: 'vector',
      project: 'P1001',
    });
    expect(hits.map(h => h.id)).toEqual([inScope.id]);
  });

  it('edit invalidates vector and re-queues via getUnembedded', async () => {
    const entry = await store.write('Original motor topic\nFirst meaning.', { tags: ['#edit'] });
    store.setVectors(entry.id, unitVector([0.85, 0.15, 0.1]), MODEL, DIM);
    expect(await store.getUnembedded(10, MODEL)).toHaveLength(0);

    await store.update(entry.id, { content: 'Revised motor topic\nChanged meaning.' });
    const backlog = await store.getUnembedded(10, MODEL);
    expect(backlog.some(e => e.id === entry.id)).toBe(true);

    store.setVectors(entry.id, unitVector([0.2, 0.8, 0.1]), MODEL, DIM);
    const hits = await store.search({
      query: 'automobile',
      topK: 1,
      searchType: 'vector',
    });
    expect(hits[0]?.id).toBe(entry.id);
  });

  it('remote sync content change invalidates stale vectors', () => {
    const db = store.getDb();
    db.prepare(`
      INSERT INTO entries (id, content_type, content, tags, metadata, created_at, updated_at, accessed_at)
      VALUES ('remote-entry', 'text', 'Motor remote\nOriginal.', '[]', '{}',
        datetime('now'), datetime('now'), datetime('now'))
    `).run();
    store.setVectors('remote-entry', unitVector([0.85, 0.15, 0.1]), MODEL, DIM);

    applyRemoteEntry(
      db,
      JSON.stringify({
        id: 'remote-entry',
        content: 'Motor remote\nUpdated remotely.',
        content_type: 'text',
        depth: 0,
        confidence: 1,
        created_at: new Date().toISOString(),
        accessed_at: new Date().toISOString(),
        decay_rate: 0,
        visibility: 7,
        tags: '[]',
        irrelevant: 0,
        tombstoned_at: null,
        metadata: {},
      }),
      Date.now() + 1000,
      'remote-device',
      false,
    );

    const row = db.prepare('SELECT entry_id FROM entry_vectors WHERE entry_id = ?').get('remote-entry');
    expect(row).toBeUndefined();
  });

  it('rejects model/dimension mismatch in setVectors and search', async () => {
    const entry = await store.write('Dimension test\nBody.', { tags: ['#dim'] });
    expect(() => store.setVectors(entry.id, new Float32Array(128), MODEL, DIM)).toThrow(/dimension/);

    store.setVectors(entry.id, unitVector([0.5, 0.5, 0.5]), MODEL, DIM);
    store.setVectors(entry.id, unitVector([0.5, 0.5, 0.5]), 'wrong-model', DIM);

    const backlog = await store.getUnembedded(10, MODEL);
    expect(backlog.some(e => e.id === entry.id)).toBe(true);

    const hits = await store.search({
      query: 'dimension',
      topK: 5,
      searchType: 'vector',
    });
    expect(hits.find(h => h.id === entry.id)).toBeUndefined();
  });

  it('getSemanticIndexHealth reports counts without loading a model', async () => {
    await store.write('Health check entry\nBody.', { tags: ['#health'] });
    const health = store.getSemanticIndexHealth();
    expect(health.providerState).toBe('enabled');
    expect(health.unembeddedCount).toBeGreaterThanOrEqual(1);
    expect(health.vectorCount).toBe(0);
  });

  it('disabled provider: vector mode empty, hybrid degrades to lexical', async () => {
    const disabledStore = new TimStore(path.join(dir, 'disabled.db'), {
      embeddingProvider: createDisabledEmbeddingProvider(),
    });
    const entry = await disabledStore.write('Lexical anchor token\nVisible body.', { tags: ['#lex'] });
    disabledStore.setVectors(entry.id, unitVector([0.9, 0.1, 0.05]), MODEL, DIM);

    const vectorHits = await disabledStore.search({
      query: 'Lexical anchor',
      searchType: 'vector',
    });
    expect(vectorHits).toEqual([]);
    expect(disabledStore.lastSearchSemantic?.vectorUnavailable).toBe(true);

    const hybridHits = await disabledStore.search({
      query: 'Lexical anchor',
      searchType: 'hybrid',
    });
    expect(hybridHits.length).toBeGreaterThanOrEqual(1);
    expect(disabledStore.lastSearchSemantic?.degradedToLexical).toBe(true);
    disabledStore.close();
  });

  it('unsupported model ID yields unavailable provider without silent MiniLM', async () => {
    process.env.TIM_EMBEDDING_MODEL = 'nonexistent-model-v9';
    const unavailableStore = new TimStore(path.join(dir, 'bad-model.db'));
    const entry = await unavailableStore.write('Unavailable model test\nBody.', { tags: ['#x'] });
    unavailableStore.setVectors(entry.id, unitVector([0.5, 0.5, 0.5]), MODEL, DIM);

    const hits = await unavailableStore.search({
      query: 'unavailable',
      searchType: 'vector',
    });
    expect(hits).toEqual([]);
    expect(unavailableStore.lastSearchSemantic?.providerState).toBe('unavailable');
    unavailableStore.close();
  });

  it('explicit FTS never initializes embedding provider', async () => {
    const embedSpy = vi.spyOn(provider, 'embed');
    const entry = await store.write('FTS only topic\nNo vectors needed.', { tags: ['#fts'] });
    store.setVectors(entry.id, unitVector([0.5, 0.5, 0.5]), MODEL, DIM);

    await store.search({ query: 'FTS only', searchType: 'fts' });
    expect(embedSpy).not.toHaveBeenCalled();
    expect(store.lastSearchSemantic?.providerState).toBe('disabled');
  });

  it('embeddingText uses title and content slice used by indexing', () => {
    const text = embeddingText('Title line', 'Body line');
    expect(text).toBe('Title line\nBody line');
  });

  it('cosineSimilarity ranks aligned vectors higher', () => {
    const a = unitVector([1, 0, 0]);
    const b = unitVector([0.99, 0.01, 0]);
    const c = unitVector([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});

describe('unavailable injected provider', () => {
  it('createUnavailableEmbeddingProvider embed throws', async () => {
    const p = createUnavailableEmbeddingProvider('bad-model');
    expect(p.state).toBe('unavailable');
    await expect(p.embed(['test'])).rejects.toThrow(/unavailable/);
  });
});
