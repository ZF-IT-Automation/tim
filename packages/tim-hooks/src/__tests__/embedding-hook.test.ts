import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { embedUnembeddedEntries } from '../hooks.js';

function mockFastembed() {
  return {
    EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2' },
    FlagEmbedding: {
      init: vi.fn(async () => ({
        embed: async function* (texts: string[]) {
          yield texts.map(() => Array.from({ length: 384 }, (_, i) => i / 384));
        },
      })),
    },
  };
}

vi.mock('fastembed', mockFastembed);

describe('embedUnembeddedEntries', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('embeds entries that have no vectors yet', async () => {
    const e = await store.write('Test content for embedding.\nBody here.', {
      tags: ['#test', '#embedding'],
    });

    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBeGreaterThanOrEqual(1);

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.find(u => u.id === e.id)).toBeUndefined();
  });

  it('skips entries that are already embedded', async () => {
    const e = await store.write('Test\nBody.', { tags: ['#a', '#b'] });
    store.setVectors(e.id, new Float32Array(384), 'test-model');

    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBe(0);
  });

  it('returns 0 when there are no unembedded entries', async () => {
    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBe(0);
  });

  it('TIM_EMBEDDING_DISABLED=1 skips processing', async () => {
    process.env.TIM_EMBEDDING_DISABLED = '1';
    try {
      const count = await embedUnembeddedEntries(store, { batchSize: 5 });
      expect(count).toBe(0);
    } finally {
      delete process.env.TIM_EMBEDDING_DISABLED;
    }
  });

  it('embeds with the real local model when explicitly enabled', async () => {
    if (process.env.TIM_EMBEDDING_REAL_MODEL !== '1') return;

    try {
      vi.doUnmock('fastembed');
      vi.resetModules();

      const { embedUnembeddedEntries: realEmbed } = await import('../hooks.js');
      const e = await store.write('Real model test\nBody.', { tags: ['#embedding'] });
      const count = await realEmbed(store, { batchSize: 5 });
      expect(count).toBeGreaterThanOrEqual(1);
      const unembedded = await store.getUnembedded(10);
      expect(unembedded.find(u => u.id === e.id)).toBeUndefined();
    } finally {
      vi.mock('fastembed', mockFastembed);
      vi.resetModules();
    }
  });
});
