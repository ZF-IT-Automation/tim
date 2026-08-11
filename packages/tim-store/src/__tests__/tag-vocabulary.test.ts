import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from '../index.js';

describe('projectTagVocabulary (topic recall, criteria 1 + 2)', () => {
  let store: TimStore;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    await store.createProject('P0091', { content: 'vocabulary tests' });
    await store.createProject('P0092', { content: 'the other project' });
  });

  afterEach(() => {
    store.close();
  });

  async function writeTagged(project: string, title: string, tags: string[]) {
    const root = (await store.read(project))!;
    return store.write(title, { parentId: root.id, title, tags });
  }

  it('returns every distinct tag of the project, most frequent first', async () => {
    await writeTagged('P0091', 'a', ['#sync', '#schema']);
    await writeTagged('P0091', 'b', ['#sync']);
    await writeTagged('P0091', 'c', ['#sync', '#schema']);
    await writeTagged('P0091', 'd', ['#rare']);

    const vocab = await store.projectTagVocabulary('P0091');
    expect(vocab).toEqual([
      { tag: '#sync', count: 3 },
      { tag: '#schema', count: 2 },
      { tag: '#rare', count: 1 },
    ]);
  });

  it('is scoped to the project — another project\'s tags never leak in', async () => {
    await writeTagged('P0091', 'mine', ['#mine']);
    await writeTagged('P0092', 'theirs', ['#theirs']);

    const vocab = await store.projectTagVocabulary('P0091');
    expect(vocab.map(t => t.tag)).toEqual(['#mine']);
  });

  // The two tags the session tree still stamps on every batch would otherwise
  // top the list in every project and tell the summarizer nothing.
  it('excludes the two automatically stamped tags', async () => {
    await writeTagged('P0091', 'a', ['#session-summary', '#batch-summary', '#topic-recall']);

    const vocab = await store.projectTagVocabulary('P0091');
    expect(vocab.map(t => t.tag)).toEqual(['#topic-recall']);
  });

  // The single most likely implementation mistake: these words look structural,
  // but in a project about sessions and checkpoints they are subject matter.
  // Filtering them guts the vocabulary this feature exists to build.
  it('keeps the retired structural words as content tags', async () => {
    await writeTagged('P0091', 'reaping', ['#checkpoint', '#session', '#exchange', '#sessions']);

    const vocab = await store.projectTagVocabulary('P0091');
    expect(vocab.map(t => t.tag).sort()).toEqual([
      '#checkpoint', '#exchange', '#session', '#sessions',
    ]);
  });

  it('returns nothing for an unknown project instead of throwing', async () => {
    expect(await store.projectTagVocabulary('P9999')).toEqual([]);
  });

  it('reaches the summarizer on the batch, scoped to that batch\'s project', async () => {
    const sessions = new SessionManager(store);
    await writeTagged('P0091', 'prior work', ['#topic-recall', '#topic-recall']);
    await sessions.startProjectSession({
      sessionId: 'voc-1',
      projectId: 'P0091',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
    });
    await sessions.logExchange('voc-1', [
      { role: 'user', content: 'Q' },
      { role: 'agent', content: 'A' },
    ]);

    const batch = await sessions.showUnsummarized('voc-1');
    expect(batch.vocabulary).toContain('#topic-recall');
    expect(batch.vocabulary).not.toContain('#session-summary');
  });
});
