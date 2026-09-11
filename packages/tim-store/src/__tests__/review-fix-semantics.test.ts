import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, resetDefaultEmbeddingProviderCache, type EmbeddingProvider } from '../index.js';

const MODEL = 'all-MiniLM-L6-v2';
const DIM = 8;

function vec(values: number[]): Float32Array {
  const a = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) a[i] = values[i];
  return a;
}

describe('review-fix F1/F5 semantics', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-review-fix-'));
    delete process.env.TIM_EMBEDDING_DISABLED;
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
    resetDefaultEmbeddingProviderCache();
  });

  it('F1: concurrent searches return independent semantic metadata', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: EmbeddingProvider = {
      modelId: MODEL,
      dimension: DIM,
      state: 'enabled',
      embed: async () => {
        await gate;
        return [vec([1, 0, 0, 0])];
      },
    };
    store = new TimStore(path.join(dir, 'meta.db'), { embeddingProvider: provider });
    const project = await store.createProject('P9002', { content: 'repro', memoryOnly: true });
    await store.write('Alpha note', { parentId: project.id, content: 'alpha content', tags: ['#a', '#b'] });

    const slow = store.searchWithSemantics({ query: 'alpha', searchType: 'vector' });
    await new Promise(r => setImmediate(r));
    const fast = await store.searchWithSemantics({ query: 'alpha', searchType: 'fts' });
    release();
    const slowResult = await slow;

    expect(slowResult.semantic.requestedMode).toBe('vector');
    expect(fast.semantic.requestedMode).toBe('fts');
    expect(fast.semantic.providerState).toBe('disabled');
  });

  it('F5: hybrid keeps exact lexical match ahead of weak vector-only noise', async () => {
    const provider: EmbeddingProvider = {
      modelId: MODEL,
      dimension: DIM,
      state: 'enabled',
      embed: async (texts) => texts.map((t) => {
        if (t.toLowerCase().includes('kubernetes')) return vec([1, 0, 0]);
        return vec([0.15, 0.98, 0]);
      }),
    };
    store = new TimStore(path.join(dir, 'hybrid.db'), { embeddingProvider: provider });
    const project = await store.createProject('P9001', { content: 'repro', memoryOnly: true });

    const exact = await store.write('Kubernetes ingress runbook', {
      parentId: project.id,
      content: 'kubernetes ingress controller restart steps',
      tags: ['#ops', '#k8s'],
    });

    for (let i = 0; i < 12; i++) {
      const e = await store.write(`Unrelated note ${i}`, {
        parentId: project.id,
        content: `baking sourdough bread ${i}`,
        tags: ['#noise', '#bake'],
      });
      const v = (await provider.embed([`x ${i}`]))[0];
      store.setVectors(e.id, v, MODEL, DIM);
    }

    const ftsOnly = await store.search({ query: 'kubernetes ingress', topK: 5, searchType: 'fts' });
    expect(ftsOnly[0]?.id).toBe(exact.id);

    const hybrid = await store.search({ query: 'kubernetes ingress', topK: 5, searchType: 'hybrid' });
    expect(hybrid[0]?.id).toBe(exact.id);
  });

  it('hybrid without vectors uses rankByUsage (deterministic, no provider)', async () => {
    const disabledProvider: EmbeddingProvider = {
      modelId: MODEL,
      dimension: DIM,
      state: 'disabled',
      embed: async () => { throw new Error('disabled'); },
    };
    store = new TimStore(path.join(dir, 'usage.db'), { embeddingProvider: disabledProvider });
    const strongFts = await store.write(
      'Deployment checklist deployment steps\nDeployment deployment deployment.',
      { tags: ['#deploy', '#ops'] },
    );
    const weakFts = await store.write(
      'Server notes\nOne mention of deployment here.',
      { tags: ['#deploy', '#ops'] },
    );
    for (const sid of ['s1', 's2', 's3']) {
      store.recordRead([weakFts.id], sid);
      store.markReferenced([weakFts.id], sid);
    }

    const { entries, semantic } = await store.searchWithSemantics({
      query: 'deployment',
      topK: 5,
      searchType: 'hybrid',
    });
    expect(semantic.degradedToLexical).toBe(true);
    const ids = entries.map(e => e.id);
    expect(ids.indexOf(weakFts.id)).toBeLessThan(ids.indexOf(strongFts.id));
  });
});

describe('review-fix F6 default provider model identity', () => {
  afterEach(() => {
    resetDefaultEmbeddingProviderCache();
    vi.resetModules();
    delete process.env.TIM_EMBEDDING_MODEL;
  });

  it('uses spec.fastembedEnum and validates dimension without downloading models', async () => {
    vi.resetModules();
    const initArgs: unknown[] = [];
    vi.doMock('fastembed', () => ({
      EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2', OtherModel: 'other-model' },
      FlagEmbedding: {
        init: vi.fn(async (opts: { model: string }) => {
          initArgs.push(opts);
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
    const provider = await getDefaultEmbeddingProvider('all-MiniLM-L6-v2');
    expect(provider?.state).toBe('enabled');
    expect(initArgs).toEqual([{ model: 'fast-all-MiniLM-L6-v2' }]);
  });

  it('rejects unsupported fastembedEnum mapping as unavailable', async () => {
    vi.resetModules();
    vi.doMock('fastembed', () => ({
      EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2' },
      FlagEmbedding: { init: vi.fn() },
    }));
    const { getDefaultEmbeddingProvider, SUPPORTED_EMBEDDING_MODELS, resetDefaultEmbeddingProviderCache: reset } =
      await import('../embedding-provider.js');
    reset();
    const original = SUPPORTED_EMBEDDING_MODELS['all-MiniLM-L6-v2'];
    SUPPORTED_EMBEDDING_MODELS['test-unknown-enum'] = {
      fastembedEnum: 'nonexistent-fastembed-model',
      dimension: 384,
    };
    const provider = await getDefaultEmbeddingProvider('test-unknown-enum');
    expect(provider?.state).toBe('unavailable');
    delete SUPPORTED_EMBEDDING_MODELS['test-unknown-enum'];
    Object.assign(SUPPORTED_EMBEDDING_MODELS, { 'all-MiniLM-L6-v2': original });
  });
});
