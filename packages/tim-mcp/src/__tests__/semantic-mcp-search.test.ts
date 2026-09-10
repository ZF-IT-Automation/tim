import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, type EmbeddingProvider } from 'tim-store';
import { executeTimSearch } from '../tim-search-tool.js';

const CUSTOM_MODEL = 'mcp-test-model-v2';
const DIM = 384;

function unitVector(values: number[]): Float32Array {
  const arr = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}

describe('tim_search semantic MCP path (in-process)', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-semantic-'));
    const provider: EmbeddingProvider = {
      modelId: CUSTOM_MODEL,
      dimension: DIM,
      state: 'enabled',
      embed: async (texts) =>
        texts.map(t => {
          if (t.toLowerCase().includes('automobile')) {
            return unitVector([0.9, 0.1, 0.05]);
          }
          return unitVector([0.1, 0.1, 0.1]);
        }),
    };
    store = new TimStore(path.join(dir, 'test.db'), { embeddingProvider: provider });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns no-overlap vector match through executeTimSearch', async () => {
    const entry = await store.write('Motor transport notes\nUses internal combustion.', {
      tags: ['#transport'],
    });
    store.setVectors(entry.id, unitVector([0.85, 0.15, 0.1]), CUSTOM_MODEL, DIM);

    const { response, results } = await executeTimSearch(store, {
      query: 'automobile',
      searchType: 'vector',
      topK: 3,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(entry.id);
    expect(response.semantic).toBeDefined();
    expect((response.semantic as { configuredModel: string }).configuredModel).toBe(CUSTOM_MODEL);
  });

  it('reports vector unavailable when embed fails in hybrid mode', async () => {
    const failing: EmbeddingProvider = {
      modelId: CUSTOM_MODEL,
      dimension: DIM,
      state: 'enabled',
      embed: async () => {
        throw new Error('embed failed');
      },
    };
    const failStore = new TimStore(path.join(dir, 'fail.db'), { embeddingProvider: failing });
    await failStore.write('LexicalOnlyNeedle\nVisible body.', { tags: ['#lex'] });

    const { response } = await executeTimSearch(failStore, {
      query: 'LexicalOnlyNeedle',
      searchType: 'hybrid',
      topK: 3,
    });

    const semantic = response.semantic as {
      degradedToLexical?: boolean;
      vectorUnavailable?: boolean;
      configuredModel: string;
    };
    expect(semantic.degradedToLexical).toBe(true);
    expect(semantic.vectorUnavailable).toBe(true);
    expect(semantic.configuredModel).toBe(CUSTOM_MODEL);
    failStore.close();
  });
});
