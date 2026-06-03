import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

describe('resolveProjectLabel', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('resolves direct label', async () => {
    await store.createProject('P0048', { content: 'o9k project' });
    const r = await store.resolveProjectLabel('P0048');
    expect(r).toEqual({ status: 'found', label: 'P0048' });
  });

  it('resolves alias to project label', async () => {
    await store.createProject('P0048', { content: 'o9k', aliases: ['o9k', 'hmem'] });
    const r = await store.resolveProjectLabel('o9k');
    expect(r).toEqual({ status: 'found', label: 'P0048' });
  });

  it('alias lookup is case-insensitive', async () => {
    await store.createProject('P0048', { aliases: ['O9K'] });
    const r = await store.resolveProjectLabel('O9K');
    expect(r.status).toBe('found');
  });

  it('returns not_found for unknown query', async () => {
    const r = await store.resolveProjectLabel('nope');
    expect(r).toEqual({ status: 'not_found', query: 'nope' });
  });

  it('returns ambiguous when multiple projects share alias', async () => {
    await store.createProject('P0048', { aliases: ['shared'] });
    await store.createProject('P0099', { aliases: ['shared'] });
    const r = await store.resolveProjectLabel('shared');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.labels).toEqual(['P0048', 'P0099']);
    }
  });

  it('loadProject loads via alias', async () => {
    await store.createProject('P0048', { content: 'body', aliases: ['o9k'] });
    const loaded = await store.loadProject('o9k');
    expect(loaded?.project.metadata.label).toBe('P0048');
  });
});
