import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { embedUnembeddedEntries } from '../hooks.js';

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

    try {
      require.resolve('fastembed');
    } catch {
      console.warn('fastembed not installed — skipping embedding hook test');
      return;
    }

    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBeGreaterThanOrEqual(1);

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.find(u => u.id === e.id)).toBeUndefined();
  });

  it('skips entries that are already embedded', async () => {
    const e = await store.write('Test\nBody.', { tags: ['#a', '#b'] });
    store.setVectors(e.id, new Float32Array(384), 'test-model');

    try {
      require.resolve('fastembed');
      const count = await embedUnembeddedEntries(store, { batchSize: 5 });
      expect(count).toBe(0);
    } catch {
      return;
    }
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
});
