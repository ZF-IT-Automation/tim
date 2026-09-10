import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

describe('scoped search before limits', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  async function seedProject(label: string, entries: string[]): Promise<void> {
    const project = await store.createProject(label, { content: `${label} project` });
    for (const content of entries) {
      await store.write(content, { parentId: project.id, tags: ['#note'] });
    }
  }

  it('finds in-project match despite higher-ranked foreign FTS hits on the same query', async () => {
    const foreign = Array.from({ length: 14 }, (_, i) =>
      `UniqueNeedleToken UniqueNeedleToken UniqueNeedleToken filler ${i}\nForeign dominance line.`,
    );
    await seedProject('P0002', foreign);
    await seedProject('P0001', ['UniqueNeedleToken\nKeep this project-specific memory.']);

    const hits = await store.search({
      query: 'UniqueNeedleToken',
      topK: 3,
      searchType: 'fts',
      project: 'P0001',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('Keep this project-specific memory');
    expect(store.getProjectLabel(hits[0].id)).toBe('P0001');
  });

  it('resolves nested task status before limiting results', async () => {
    const project = await store.createProject('P0100', { content: 'Status project' });
    await store.write('StatusNeedle open task', {
      parentId: project.id,
      tags: ['#task'],
      metadata: { task: { status: 'todo' } },
    });
    await store.write('StatusNeedle done task', {
      parentId: project.id,
      tags: ['#task'],
      metadata: { task: { status: 'done' } },
    });

    const openHits = await store.search({
      query: 'StatusNeedle',
      topK: 5,
      searchType: 'fts',
      project: 'P0100',
      status: 'todo',
    });
    expect(openHits).toHaveLength(1);
    expect(openHits[0].title).toContain('open task');

    const doneHits = await store.search({
      query: 'StatusNeedle',
      topK: 5,
      searchType: 'fts',
      project: 'P0100',
      status: 'done',
    });
    expect(doneHits).toHaveLength(1);
    expect(doneHits[0].title).toContain('done task');
  });

  it('status filter survives more than 1000 higher-ranked excluded matches', async () => {
    const project = await store.createProject('P0200', { content: 'Status starvation project' });
    for (let i = 0; i < 1001; i++) {
      await store.write(
        `StatusStarveToken StatusStarveToken StatusStarveToken done filler ${i}`,
        {
          parentId: project.id,
          tags: ['#task'],
          metadata: { task: { status: 'done' } },
        },
      );
    }
    await store.write('StatusStarveToken weak todo match', {
      parentId: project.id,
      tags: ['#task'],
      metadata: { task: { status: 'todo' } },
    });

    const hits = await store.search({
      query: 'StatusStarveToken',
      topK: 1,
      searchType: 'fts',
      project: 'P0200',
      status: 'todo',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('weak todo match');
  });

  it('exact tag filter survives LIKE wildcard characters and foreign dominance', async () => {
    const project = await store.createProject('P0300', { content: 'Tag project' });
    const wildcardTag = '#wild%_tag';
    for (let i = 0; i < 14; i++) {
      await store.write(`TagStarveToken TagStarveToken TagStarveToken filler ${i}`, {
        parentId: project.id,
        tags: ['#note'],
      });
    }
    await store.write('TagStarveToken tagged needle', {
      parentId: project.id,
      tags: [wildcardTag],
    });

    const hits = await store.search({
      query: 'TagStarveToken',
      topK: 1,
      searchType: 'fts',
      project: 'P0300',
      tag: wildcardTag,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('tagged needle');
    expect(hits[0].tags).toContain(wildcardTag);
  });
});
