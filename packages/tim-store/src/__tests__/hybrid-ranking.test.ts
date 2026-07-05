import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

vi.mock('fastembed', () => ({
  EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2' },
  FlagEmbedding: {
    init: vi.fn(async () => ({
      embed: vi.fn(async function* (texts: string[]) {
        yield texts.map(() => makeMockVector([0.5, 0.7, 0.3]));
      }),
    })),
  },
}));

describe('hybrid search', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
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
    const a = await store.write('test query match\nContent.', { tags: ['#a', '#b'] });
    const results = await store.search({ query: 'test query', topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(a.id);
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

    store.setVectors(semantic.id, makeMockVector([0.5, 0.7, 0.3]), 'test-model');
    store.setVectors(exact.id, makeMockVector([0.1, 0.1, 0.2]), 'test-model');

    const results = await store.search({ query: 'error handling python', topK: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(semantic.id);
  });
});

function makeMockVector(values: number[]): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}
