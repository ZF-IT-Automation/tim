import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('suite embedding default', () => {
  let store: TimStore;

  afterEach(() => {
    store?.close();
  });

  it('default hybrid search does not download or load a real embedding model', async () => {
    const models = path.join(os.homedir(), '.tim', 'models');
    expect(process.env.TIM_EMBEDDING_DISABLED).toBe('1');
    expect(fs.existsSync(models)).toBe(false);

    store = new TimStore(':memory:');
    await store.write('programming notes\nTypeScript and Rust.', { tags: ['#note'] });
    const results = await store.search({ query: 'programming' });

    expect(results).toHaveLength(1);
    expect(store.lastSearchSemantic?.providerState).toBe('disabled');
    expect(store.lastSearchSemantic?.degradedToLexical).toBe(true);
    expect(fs.existsSync(models)).toBe(false);
  });
});
