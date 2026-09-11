import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, type EmbeddingProvider } from 'tim-store';
import { executeTimSearch } from '../tim-search-tool.js';

const MODEL = 'all-MiniLM-L6-v2';
const DIM = 4;

describe('review-fix F1 MCP semantic metadata', () => {
  let dir: string;
  let store: TimStore;
  let release!: () => void;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-review-fix-mcp-'));
    delete process.env.TIM_EMBEDDING_DISABLED;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: EmbeddingProvider = {
      modelId: MODEL,
      dimension: DIM,
      state: 'enabled',
      embed: async () => {
        await gate;
        return [new Float32Array([1, 0, 0, 0])];
      },
    };
    store = new TimStore(path.join(dir, 'a.db'), { embeddingProvider: provider });
    const p = await store.createProject('P9002', { content: 'repro', memoryOnly: true });
    await store.write('Alpha note', { parentId: p.id, content: 'alpha content', tags: ['#a', '#b'] });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('concurrent vector and fts searches keep independent semantic metadata', async () => {
    const slow = executeTimSearch(store, { query: 'alpha', searchType: 'vector' });
    await new Promise(r => setImmediate(r));
    const fast = await executeTimSearch(store, { query: 'alpha', searchType: 'fts' });
    release();
    const slowResult = await slow;

    expect((slowResult.semantic as { requestedMode: string }).requestedMode).toBe('vector');
    expect((fast.semantic as { requestedMode: string }).requestedMode).toBe('fts');
    expect((fast.semantic as { providerState: string }).providerState).toBe('disabled');
  });
});
