import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimStore, type EmbeddingProvider } from '../store.js';

const MODEL = 'all-MiniLM-L6-v2';
const DIM = 384;

describe('search searchType', () => {
  let store: TimStore;
  let embedSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    embedSpy = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array(DIM)),
    );
    const provider: EmbeddingProvider = {
      modelId: MODEL,
      dimension: DIM,
      state: 'enabled',
      embed: embedSpy,
    };
    store = new TimStore(':memory:', { embeddingProvider: provider });
  });

  afterEach(() => {
    store.close();
  });

  it('searchType fts skips embedding provider even when vectors exist', async () => {
    const entry = await store.write('embedding topic alpha', {
      tags: ['#alpha'],
      metadata: { kind: 'lesson' },
    });
    store.setVectors(entry.id, new Float32Array(DIM), MODEL, DIM);

    await store.search({ query: 'alpha embedding', topK: 5, searchType: 'fts' });
    expect(embedSpy).not.toHaveBeenCalled();
  });
});
