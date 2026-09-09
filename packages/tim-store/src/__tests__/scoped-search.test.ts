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

  it('finds in-project match despite higher-ranked foreign FTS hits', async () => {
    const foreign = Array.from({ length: 14 }, (_, i) =>
      `common filler topic alpha beta gamma ${i}\nForeign dominance line.`,
    );
    await seedProject('P0002', foreign);
    await seedProject('P0001', ['UniqueNeedleToken\nKeep this project-specific memory.']);

    const hits = await store.search({
      query: '"UniqueNeedleToken"',
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
});
