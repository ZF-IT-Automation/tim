import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimStore, type EmbeddingProvider } from 'tim-store';
import { startEmbeddingTimer, stopEmbeddingTimer } from '../idle-sweep-timer.js';

function provider(): EmbeddingProvider {
  return {
    modelId: 'all-MiniLM-L6-v2',
    dimension: 384,
    state: 'enabled',
    embed: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.5)),
  };
}

describe('embedding timer', () => {
  afterEach(() => stopEmbeddingTimer());

  it('backfills every unembedded entry on its first pass, batch after batch', async () => {
    const store = new TimStore(':memory:', { embeddingProvider: provider() });
    const project = await store.createProject('P0901', { content: 'P0901 — Test | Active' });
    for (let i = 0; i < 70; i++) {
      await store.write(`Entry ${i}\nbody ${i}`, { parentId: project.id, tags: ['#t', '#x'] });
    }
    expect((await store.getUnembedded(100, 'all-MiniLM-L6-v2')).length).toBeGreaterThan(64);

    startEmbeddingTimer(store, 60_000);
    await vi.waitFor(async () => {
      expect(await store.getUnembedded(100, 'all-MiniLM-L6-v2')).toHaveLength(0);
    }, { timeout: 5000 });
    store.close();
  });
});
