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

  it('search returns project by label when label is not in FTS corpus', async () => {
    await store.createProject('P0063', { content: 'body only, no P0063 in title' });
    const results = await store.search({ query: 'P0063' });
    expect(results).toHaveLength(1);
    expect(results[0]!.metadata.label).toBe('P0063');
  });

  it('search returns project by alias', async () => {
    await store.createProject('P0048', { content: 'body', aliases: ['o9k'] });
    const results = await store.search({ query: 'o9k' });
    expect(results.some(e => e.metadata.label === 'P0048')).toBe(true);
  });

  it('search still finds content hits and does not duplicate label match', async () => {
    await store.createProject('P0063', { content: 'Infinite memory system' });
    const results = await store.search({ query: 'Infinite' });
    expect(results).toHaveLength(1);
    expect(results.filter(e => e.metadata.label === 'P0063')).toHaveLength(1);
  });

  it('createProject rejects duplicate label', async () => {
    await store.createProject('P0001', { content: 'first' });
    await expect(store.createProject('P0001', { content: 'second' }))
      .rejects.toThrow(/Project label already exists/);
  });

  it('createProject allows same label after tombstone', async () => {
    const first = await store.createProject('P0001', { content: 'first' });
    await store.delete(first.id, true);
    const second = await store.createProject('P0001', { content: 'second' });
    expect(second.id).not.toBe(first.id);
    expect(second.metadata.label).toBe('P0001');
  });

  it('search topK honored when label hit merged', async () => {
    await store.createProject('TX', { content: 'target project' });
    for (let i = 0; i < 15; i++) {
      await store.write('TX matching content ' + i, { tags: [] });
    }
    const results = await store.search({ query: 'TX', topK: 5 });
    expect(results).toHaveLength(5);
    expect(results[0].metadata.label).toBe('TX');
  });

  it('createProject rejects when irrelevant entry with same label exists', async () => {
    const first = await store.createProject('PXR', { content: 'will be irrelevant' });
    await store.update(first.id, { irrelevant: true });
    await expect(store.createProject('PXR', { content: 'should fail' }))
      .rejects.toThrow(/Project label already exists/);
  });
});
