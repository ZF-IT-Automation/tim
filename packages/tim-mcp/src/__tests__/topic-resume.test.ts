import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from 'tim-store';
import { collectTopicResume, formatTopicResume } from '../topic-resume.js';

describe('tag-only retrieval (criterion 4)', () => {
  let store: TimStore;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    await store.createProject('P0081', { content: 'tag lookup tests' });
  });

  afterEach(() => store.close());

  // Written in chronological order: created_at ties break on the ULID, which is
  // itself monotonic, so insertion order is the expected order.
  async function write(title: string, tags: string[]) {
    const root = (await store.read('P0081'))!;
    return store.write(title, { parentId: root.id, title, tags });
  }

  it('returns everything carrying the tag, oldest first, with no query at all', async () => {
    await write('first', ['#recall']);
    await write('unrelated', ['#other']);
    await write('second', ['#recall']);
    await write('third', ['#recall']);

    const hits = await store.searchByTag('#recall');
    // Reversing the sort must fail here — a topic history is only legible in the
    // order it happened.
    expect(hits.map(h => h.title)).toEqual(['first', 'second', 'third']);
  });

  it('accepts the tag with or without the leading #', async () => {
    await write('one', ['#recall']);
    expect((await store.searchByTag('recall')).map(h => h.title)).toEqual(['one']);
  });

  it('respects topK by keeping the oldest, not a random slice', async () => {
    await write('a', ['#recall']);
    await write('b', ['#recall']);
    await write('c', ['#recall']);

    expect((await store.searchByTag('#recall', 2)).map(h => h.title)).toEqual(['a', 'b']);
  });

  it('does not match a tag that merely contains the needle', async () => {
    await write('exact', ['#sync']);
    await write('longer', ['#sync-server']);

    expect((await store.searchByTag('#sync')).map(h => h.title)).toEqual(['exact']);
  });
});

describe('tim_resume_topic (criteria 5, 6, 7)', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0082', { content: 'topic resume tests' });
  });

  afterEach(() => store.close());

  /** A session with one summarized batch carrying `tag`, plus two raw turns after it. */
  async function seedSession(opts: {
    id: string;
    date: string;
    tag: string;
    summary: string;
    handoffNote?: string;
    rawTurn?: string;
  }) {
    await sessions.startProjectSession({
      sessionId: opts.id,
      projectId: 'P0082',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });
    await store.update(opts.id, { metadata: { date: opts.date } });
    // Two exchanges, both covered by the batch summary below — so a raw turn
    // logged afterwards is genuinely uncovered rather than merely re-read.
    await sessions.logExchange(opts.id, [
      { role: 'user', content: `${opts.id} covered question` },
      { role: 'agent', content: 'covered answer' },
      { role: 'user', content: `${opts.id} second covered question` },
      { role: 'agent', content: 'second covered answer' },
    ]);
    await sessions.writeBatchSummary(opts.id, 1, opts.summary, { seqFrom: 1, seqTo: 2 }, [opts.tag]);
    if (opts.handoffNote) {
      await sessions.checkpoint(opts.id, {
        summarize: async () => 'checkpoint stub',
        handoffNote: opts.handoffNote,
      });
    }
    // After the last summary, so these are the turns nothing covers — which is
    // exactly what the raw tail exists to carry.
    if (opts.rawTurn) {
      await sessions.logExchange(opts.id, [
        { role: 'user', content: opts.rawTurn },
        { role: 'agent', content: 'uncovered answer' },
      ]);
    }
  }

  it('returns batch summaries from every matching session, in session order', async () => {
    await seedSession({
      id: 'newer', date: '2026-02-01T10:00:00.000Z', tag: '#recall',
      summary: 'the second pass', handoffNote: 'next: ship it', rawTurn: 'newest raw turn',
    });
    await seedSession({
      id: 'older', date: '2026-01-01T10:00:00.000Z', tag: '#recall',
      summary: 'the first pass', handoffNote: 'next: do not use this note',
    });

    const topic = await collectTopicResume(store, 'P0082', 'recall');

    expect(topic.sessions.map(s => s.summary)).toEqual(['the first pass', 'the second pass']);
    // Criteria 5 + 7: exactly one note, the newest hit's, and the raw turns come
    // from that same session — never a note from one session beside turns from another.
    expect(topic.newest?.sessionId).toBe('newer');
    expect(topic.newest?.handoffNote).toBe('next: ship it');
    expect(topic.newest?.rawTurns.join('\n')).toContain('newest raw turn');

    const text = formatTopicResume(topic);
    expect(text).not.toContain('do not use this note');
  });

  it('says the newest session has no note instead of reaching back to an older one', async () => {
    await seedSession({
      id: 'has-note', date: '2026-01-01T10:00:00.000Z', tag: '#recall',
      summary: 'earlier work', handoffNote: 'next: this note belongs to the older session',
    });
    await seedSession({
      id: 'no-note', date: '2026-02-01T10:00:00.000Z', tag: '#recall',
      summary: 'later work',
    });

    const topic = await collectTopicResume(store, 'P0082', '#recall');
    expect(topic.newest?.sessionId).toBe('no-note');
    expect(topic.newest?.handoffNote).toBeUndefined();

    const text = formatTopicResume(topic);
    // Adding a fallback to the older note must fail this test: a missing note is
    // information, a foreign one is a false statement about the current state.
    expect(text).not.toContain('this note belongs to the older session');
    expect(text).toContain('No handoff note');
    expect(text).toContain('no-note');
  });

  it('includes the tasks, bugs and ideas that share the tag', async () => {
    const root = (await store.read('P0082'))!;
    await store.write('Ship topic recall', {
      parentId: root.id,
      title: 'Ship topic recall',
      tags: ['#recall'],
      metadata: { task: { status: 'todo' } },
    });
    await store.write('Tag lookup under-reports', {
      parentId: root.id,
      title: 'Tag lookup under-reports',
      tags: ['#recall'],
      metadata: { kind: 'bug', status: 'open' },
    });
    await store.write('Unrelated task', {
      parentId: root.id,
      title: 'Unrelated task',
      tags: ['#other'],
      metadata: { task: { status: 'todo' } },
    });

    const topic = await collectTopicResume(store, 'P0082', '#recall');
    expect(topic.work.map(w => w.title).sort()).toEqual([
      'Ship topic recall',
      'Tag lookup under-reports',
    ]);
  });

  it('says so plainly when nothing carries the tag', async () => {
    const topic = await collectTopicResume(store, 'P0082', '#nothing-here');
    expect(formatTopicResume(topic)).toBe('No entries tagged #nothing-here in P0082.');
  });

  // A rendered result that hides its own incompleteness is the worse failure of
  // the two: the empty case at least prompts the reader to look further, while
  // "1 session" reads as the whole answer. Measured against the live database,
  // #topic-recall matched five entries in P0063 and this view rendered one.
  it('names the entries it did not render, even when it rendered some', async () => {
    await seedSession({
      id: 'has-batch', date: '2026-03-01T10:00:00.000Z', tag: '#partial',
      summary: 'the summarized part',
    });
    // A plain note: carries the tag, is neither a batch summary nor open work,
    // so no block of this view will ever show it.
    const root = (await store.read('P0082'))!;
    await store.write('a note nobody renders', { parentId: root.id, tags: ['#partial'] });

    const topic = await collectTopicResume(store, 'P0082', '#partial');
    const text = formatTopicResume(topic);

    expect(topic.sessions).toHaveLength(1);
    expect(text).toContain('── Sessions on this topic (1');
    expect(text).toMatch(/further entr(y carries|ies carry) #partial/);
    expect(text).toContain('tim_search with tag=#partial');
  });
});
