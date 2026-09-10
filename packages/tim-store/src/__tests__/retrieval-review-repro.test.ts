import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEntrySearchStatus } from 'tim-core';
import { TimStore, type EmbeddingProvider } from '../store.js';

const TEST_PROVIDER: EmbeddingProvider = {
  modelId: 'all-MiniLM-L6-v2',
  dimension: 384,
  state: 'enabled',
  embed: async (texts) => texts.map(() => new Float32Array(384)),
};

describe('retrieval review repros', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:', { embeddingProvider: TEST_PROVIDER });
  });

  afterEach(() => {
    store.close();
  });

  it('F1a: status todo excludes plain notes without task metadata', async () => {
    const project = await store.createProject('P0900', { content: 'Status filter project' });
    await store.write('StatusNeedle plain note with no task metadata', {
      parentId: project.id,
      tags: ['#note'],
    });
    await store.write('StatusNeedle real open task', {
      parentId: project.id,
      tags: ['#task'],
      metadata: { task: { status: 'todo' } },
    });

    const hits = await store.search({
      query: 'StatusNeedle',
      project: 'P0900',
      status: 'todo',
      searchType: 'fts',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('real open task');
  });

  it('F1a-starvation: real todo survives higher-ranked plain notes', async () => {
    const project = await store.createProject('P0911', { content: 'Starvation project' });
    for (let i = 0; i < 40; i++) {
      await store.write(
        `StarveNeedle StarveNeedle StarveNeedle plain note ${i}`,
        { parentId: project.id, tags: ['#note'] },
      );
    }
    await store.write('StarveNeedle real todo task', {
      parentId: project.id,
      tags: ['#task'],
      metadata: { task: { status: 'todo' } },
    });

    const hits = await store.search({
      query: 'StarveNeedle',
      project: 'P0911',
      status: 'todo',
      topK: 3,
      searchType: 'fts',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('real todo task');
  });

  it('F1b: bug fixed status matches both legacy and canonical shapes', async () => {
    const project = await store.createProject('P0901', { content: 'Bug status project' });
    await store.write('FixedNeedle legacy bug', {
      parentId: project.id,
      tags: ['#bug'],
      metadata: { status: 'fixed' },
    });
    await store.write('FixedNeedle canonical bug', {
      parentId: project.id,
      tags: ['#bug'],
      metadata: { bug: { status: 'fixed' } },
    });

    const hits = await store.search({
      query: 'FixedNeedle',
      project: 'P0901',
      status: 'fixed',
      searchType: 'fts',
    });

    expect(hits).toHaveLength(2);
  });

  it('F2: root all searches across all projects', async () => {
    const p1 = await store.createProject('P0902', { content: 'Scope one' });
    const p2 = await store.createProject('P0903', { content: 'Scope two' });
    await store.write('ScopeNeedle in first', { parentId: p1.id, tags: ['#note'] });
    await store.write('ScopeNeedle in second', { parentId: p2.id, tags: ['#note'] });

    const hits = await store.search({
      query: 'ScopeNeedle',
      project: 'all',
      searchType: 'fts',
    });

    expect(hits).toHaveLength(2);
  });

  it('F2: project name containing all does not hijack root all', async () => {
    const p1 = await store.createProject('Pall01', { content: 'Name has all substring' });
    const p2 = await store.createProject('P0904', { content: 'Other project' });
    await store.write('AllNameNeedle in pall01', { parentId: p1.id, tags: ['#note'] });
    await store.write('AllNameNeedle in p0904', { parentId: p2.id, tags: ['#note'] });

    const hits = await store.search({
      query: 'AllNameNeedle',
      project: 'all',
      searchType: 'fts',
    });

    expect(hits).toHaveLength(2);
  });

  it('F2 tag-only: root all returns entries from every project', async () => {
    const p1 = await store.createProject('P0905', { content: 'Tag scope one' });
    const p2 = await store.createProject('P0906', { content: 'Tag scope two' });
    await store.write('TagScope first', { parentId: p1.id, tags: ['#scope-all'] });
    await store.write('TagScope second', { parentId: p2.id, tags: ['#scope-all'] });

    const hits = await store.searchByTag('#scope-all', 10, 'all');

    expect(hits).toHaveLength(2);
  });

  it('F4a: project-label prepend respects project scope', async () => {
    await store.createProject('P0906', { content: 'Requested scope' });
    await store.createProject('P0907', { content: 'Foreign project' });

    const hits = await store.search({
      query: 'P0907',
      project: 'P0906',
      status: 'done',
      searchType: 'fts',
    });

    expect(hits).toHaveLength(0);
  });

  it('F4b: project-label prepend respects type filter', async () => {
    await store.createProject('P0909', { content: 'Type filter project' });

    const hits = await store.search({
      query: 'P0909',
      type: 'decision',
      searchType: 'fts',
    });

    expect(hits).toHaveLength(0);
  });

  it('resolves alias and name scope before a project prepend can spend topK', async () => {
    const project = await store.createProject('P0920', { content: 'Requested project' });
    await store.update(project.id, { metadata: { aliases: ['alpha-scope'] } });
    await store.createProject('P0921', { content: 'Foreign project' });
    const hit = await store.write('P0921 local reference', { parentId: project.id });
    for (const searchType of ['fts', 'hybrid'] as const) {
      for (const scope of ['P0920', 'alpha-scope']) {
        const hits = await store.search({ query: 'P0921', project: scope, topK: 1, searchType });
        expect(hits.map(e => e.id)).toEqual([hit.id]);
      }
      expect(await store.search({ query: 'P0921', project: 'missing-scope', searchType })).toEqual([]);
    }
  });

  it('parity: SQL and TS search status agree on fixture shapes', async () => {
    const project = await store.createProject('P0910', { content: 'Parity project' });
    const fixtures: Array<{ content: string; metadata: Record<string, unknown>; expected: string | null }> = [
      { content: 'Parity plain', metadata: {}, expected: null },
      { content: 'Parity task', metadata: { task: { status: 'done' } }, expected: 'done' },
      { content: 'Parity legacy', metadata: { task: true, status: 'done' }, expected: 'done' },
      { content: 'Parity bug', metadata: { bug: { status: 'fixed' } }, expected: 'fixed' },
    ];
    for (const f of fixtures) {
      await store.write(f.content, { parentId: project.id, tags: ['#parity'], metadata: f.metadata });
      expect(resolveEntrySearchStatus(f.metadata)).toBe(f.expected);
    }

    const todoHits = await store.searchFts('Parity', 10, { project: 'P0910', status: 'done' });
    expect(todoHits.map(h => h.title)).toEqual(['Parity task', 'Parity legacy']);
  });
});
