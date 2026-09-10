import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, type EmbeddingProvider } from '../store.js';

const MODEL = 'all-MiniLM-L6-v2';
const DIM = 384;

function makeMockVector(values: number[]): Float32Array {
  const arr = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}

function makeProvider(embedFn: (texts: string[]) => Promise<Float32Array[]>): EmbeddingProvider {
  return { modelId: MODEL, dimension: DIM, state: 'enabled', embed: embedFn };
}

describe('hybrid search', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    const provider = makeProvider(async (texts) =>
      texts.map(t => {
        const lower = t.toLowerCase();
        if (lower.includes('python')) return makeMockVector([0.5, 0.7, 0.3]);
        return makeMockVector([0.1, 0.1, 0.2]);
      }),
    );
    store = new TimStore(path.join(dir, 'test.db'), { embeddingProvider: provider });
    delete process.env.TIM_EMBEDDING_DISABLED;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.TIM_EMBEDDING_DISABLED;
  });

  it('search() still works without vectors (pure FTS + usage)', async () => {
    const a = await store.write('Deploy checklist for staging\nSteps to follow.', {
      tags: ['#deploy', '#ops'],
    });
    const b = await store.write('Staging config notes\nServer setup.', {
      tags: ['#deploy', '#ops'],
    });
    const results = await store.search({ query: 'staging', topK: 2 });
    expect(results.length).toBe(2);
    const ids = results.map(e => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('TIM_EMBEDDING_DISABLED=1 falls back to pure rankByUsage', async () => {
    process.env.TIM_EMBEDDING_DISABLED = '1';
    const disabledStore = new TimStore(path.join(dir, 'disabled.db'));
    const a = await disabledStore.write('test query match\nContent.', { tags: ['#a', '#b'] });
    const results = await disabledStore.search({ query: 'test query', topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(a.id);
    disabledStore.close();
  });

  it('entries with vectors are boosted over entries without', async () => {
    const semantic = await store.write(
      'Python error handling best practices\ntry/except patterns.',
      { tags: ['#python', '#errors'] },
    );
    const exact = await store.write(
      'Javascript error handling\nPromises and async/await patterns.',
      { tags: ['#javascript', '#errors'] },
    );

    store.setVectors(semantic.id, makeMockVector([0.5, 0.7, 0.3]), MODEL, DIM);
    store.setVectors(exact.id, makeMockVector([0.1, 0.1, 0.2]), MODEL, DIM);

    const results = await store.search({ query: 'error handling python', topK: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(semantic.id);
  });
});
