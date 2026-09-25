import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimStore, type EmbeddingProvider } from 'tim-store';

const spawnMock = vi.fn(() => ({ once: vi.fn() }));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: spawnMock }));

const { drainEmbeddings } = await import('../embed-pass.js');
const { startEmbeddingTimer, stopEmbeddingTimer } = await import('../idle-sweep-timer.js');

function provider(): EmbeddingProvider {
  return {
    modelId: 'all-MiniLM-L6-v2',
    dimension: 384,
    state: 'enabled',
    embed: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.5)),
  };
}

async function storeWith(n: number): Promise<TimStore> {
  const store = new TimStore(':memory:', { embeddingProvider: provider() });
  const project = await store.createProject('P0901', { content: 'P0901 — Test | Active' });
  for (let i = 0; i < n; i++) {
    await store.write(`Entry ${i}\nbody ${i}`, { parentId: project.id, tags: ['#t', '#x'] });
  }
  return store;
}

describe('embedding pass', () => {
  afterEach(() => {
    stopEmbeddingTimer();
    spawnMock.mockClear();
  });

  it('drains every unembedded entry, batch after batch', async () => {
    const store = await storeWith(70);
    expect((await store.getUnembedded(100, 'all-MiniLM-L6-v2')).length).toBeGreaterThan(64);
    expect(await drainEmbeddings(store)).toBeGreaterThan(64);
    expect(await store.getUnembedded(100, 'all-MiniLM-L6-v2')).toHaveLength(0);
    store.close();
  });

  it('spawns the child only when something is left to embed', async () => {
    const empty = new TimStore(':memory:', { embeddingProvider: provider() });
    startEmbeddingTimer(empty, '/tmp/x.db', 60_000);
    await new Promise(r => setTimeout(r, 50));
    expect(spawnMock).not.toHaveBeenCalled();
    stopEmbeddingTimer();
    empty.close();

    const store = await storeWith(3);
    startEmbeddingTimer(store, '/tmp/y.db', 60_000);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(spawnMock.mock.calls[0]![1]).toEqual([expect.stringMatching(/embed-pass\.js$/), '/tmp/y.db']);
    store.close();
  });
});
