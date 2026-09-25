import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimStore, SessionManager, findChildByKind, KIND_BATCH, KIND_SUMMARY_ROOT } from 'tim-store';
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
    rollup?: string;
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
    if (opts.rollup) await sessions.updateSessionSummary(opts.id, opts.rollup);
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

  it('says so plainly when nothing matches the topic', async () => {
    const topic = await collectTopicResume(store, 'P0082', 'nothing-here');
    expect(formatTopicResume(topic)).toBe(
      'Nothing on "nothing-here" in P0082 — no entry carries #nothing-here and none mentions it.',
    );
  });

  // The failure that made the tool unusable, in the shape it was measured in:
  // the viewer work is tagged #tim-inspector, so a tag-only lookup for
  // "tim-viewer" returned nothing while the summaries said "tim viewer" outright.
  it('finds a session whose tag is spelled differently than the topic', async () => {
    await seedSession({
      id: 'inspector', date: '2026-04-01T10:00:00.000Z', tag: '#tim-inspector',
      summary: 'tim viewer becomes the TIM Inspector; read-only, no write tools',
    });

    expect(await store.searchByTag('#tim-viewer', 500, 'P0082')).toEqual([]);

    const topic = await collectTopicResume(store, 'P0082', 'tim-viewer');
    expect(topic.sessions.map(s => s.summary)).toEqual([
      'tim viewer becomes the TIM Inspector; read-only, no write tools',
    ]);
  });

  // FTS5 tokenizes a quoted "sync-server" as an adjacent phrase, so a
  // tag-shaped topic demanded a word order the prose never owes it. Measured in
  // P0063: "sync-server" matched no batch summary, "sync server" matched several.
  it('reads a hyphenated topic as its words, not as a fixed phrase', async () => {
    await seedSession({
      id: 'syncwork', date: '2026-06-01T10:00:00.000Z', tag: '#unrelated-tag',
      summary: 'the server now compacts what sync appends',
    });

    const topic = await collectTopicResume(store, 'P0082', 'sync-server');
    expect(topic.sessions.map(s => s.summary)).toEqual([
      'the server now compacts what sync appends',
    ]);
  });

  // Raw turns carry no tags, match the topic's words in bulk and outnumber the
  // summaries — ranked full text puts them first unless the query excludes them.
  it('never renders raw exchanges as sessions on the topic', async () => {
    await seedSession({
      id: 'chatty', date: '2026-05-01T10:00:00.000Z', tag: '#unrelated-tag',
      summary: 'the summary of the widget work',
      rawTurn: 'widget widget widget widget widget',
    });

    const topic = await collectTopicResume(store, 'P0082', 'widget');
    expect(topic.sessions.map(s => s.summary)).toEqual(['the summary of the widget work']);
  });

  it('keeps the newest sessions when capped, and still renders them oldest first', async () => {
    for (const n of [1, 2, 3]) {
      await seedSession({
        id: `s${n}`, date: `2026-0${n}-01T10:00:00.000Z`, tag: '#recall',
        summary: `pass ${n}`,
      });
    }

    const topic = await collectTopicResume(store, 'P0082', '#recall', 2);
    // Newest two selected — but rendered in the order they happened. Rendering
    // newest-first would buy the same bound and make the history read backwards.
    expect(topic.sessions.map(s => s.summary)).toEqual(['pass 2', 'pass 3']);
    expect(topic.sessionsMatched).toBe(3);
    expect(formatTopicResume(topic)).toContain('Newest 2 of 3 matching sessions');
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
    expect(text).toContain('── Sessions on this topic (1, oldest first)');
    expect(text).toMatch(/further entr(y matches|ies match) "#partial"/);
    // Summary roots are what this view renders now; naming them as unrendered
    // would send the reader looking for what is already on screen.
    expect(text).not.toContain('Summary roots');
    expect(text).toContain('tim_search with query=#partial');
  });
});

// A session is a unit of meaning; a batch is an artifact of the cadence. Rendering
// batches reprinted a session's intermediate states as if each were its
// conclusion — measured on "tim-viewer", where one session's third batch says the
// earlier decisions are superseded while the superseded ones were rendered above
// it with equal authority. The rollup is written across all batches, so it has
// already resolved that.
describe('tim_resume_topic renders sessions, not batches', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0083', { content: 'session-level rendering' });
  });

  afterEach(() => store.close());

  async function seed(id: string, date: string, batchTexts: string[], rollup?: string) {
    await sessions.startProjectSession({
      sessionId: id, projectId: 'P0083', agentName: 'test',
      cwd: '/tmp', harness: 'test', batchSize: 2,
    });
    await store.update(id, { metadata: { date } });
    await sessions.logExchange(id, [
      { role: 'user', content: `${id} question` },
      { role: 'agent', content: 'answer' },
    ]);
    for (const [i, text] of batchTexts.entries()) {
      await sessions.writeBatchSummary(id, i + 1, text, { seqFrom: 1, seqTo: 2 }, ['#widget']);
    }
    if (rollup) await sessions.updateSessionSummary(id, rollup);
  }

  it('collapses one session\'s batches into its own summary', async () => {
    await seed('multi', '2026-07-01T10:00:00.000Z', [
      'widget: decided to build it in the CLI',
      'widget: decided to build it in the daemon instead — the CLI decision is superseded',
    ], 'widget lives in the daemon; the CLI plan was dropped mid-session');

    const topic = await collectTopicResume(store, 'P0083', 'widget');

    expect(topic.sessions).toHaveLength(1);
    expect(topic.sessions[0]!.source).toBe('rollup');
    expect(topic.sessions[0]!.summary).toBe(
      'widget lives in the daemon; the CLI plan was dropped mid-session',
    );
    // The superseded decision must not be reprinted as if it still held.
    expect(formatTopicResume(topic)).not.toContain('build it in the CLI');
  });

  // 152 Summary roots in the live database are empty. Dropping those sessions
  // would silently shorten a topic's history.
  it('falls back to the batches when a session never got a summary, and says so', async () => {
    await seed('bare', '2026-07-02T10:00:00.000Z', ['widget: the only account there is']);

    const topic = await collectTopicResume(store, 'P0083', 'widget');
    expect(topic.sessions[0]!.source).toBe('batches');
    expect(topic.sessions[0]!.summary).toContain('the only account there is');

    const text = formatTopicResume(topic);
    // Stitched text is weaker evidence than a session's own account, so the
    // reader is told which one they are looking at.
    expect(text).toContain('no session summary, 1 batch');
  });

  // A Summary root carries the session's aggregated tags and its rollup text, so
  // it can match a topic none of its batches spell out. It used to be counted
  // only in the "kinds this view does not render" footer.
  it('finds a session through its Summary root alone', async () => {
    await seed('viaroot', '2026-07-03T10:00:00.000Z', ['nothing relevant in here'],
      'the sprocket subsystem was rewritten');

    const topic = await collectTopicResume(store, 'P0083', 'sprocket');
    expect(topic.sessions).toHaveLength(1);
    expect(topic.sessions[0]!.sessionId).toBe('viaroot');
    expect(topic.sessions[0]!.source).toBe('rollup');
  });
});

// OR-widened sessions are noise unless Jev keeps them. Tag and AND hits stay
// on today's path and are never sent: a real tag must not disappear because
// the rollup paraphrased it, and a null reply must not leak the raw OR set.
describe('tim_resume_topic Jev relevance filter', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0084', { content: 'jev topic filter' });
    delete process.env.JEV_API_KEY;
  });

  afterEach(() => {
    store.close();
    vi.unstubAllGlobals();
    delete process.env.JEV_API_KEY;
  });

  async function seedSession(opts: {
    id: string;
    date: string;
    tag: string;
    summary: string;
    rollup?: string;
    secondBatch?: string;
  }) {
    await sessions.startProjectSession({
      sessionId: opts.id,
      projectId: 'P0084',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });
    await store.update(opts.id, { metadata: { date: opts.date } });
    await sessions.logExchange(opts.id, [
      { role: 'user', content: `${opts.id} question` },
      { role: 'agent', content: 'answer' },
    ]);
    await sessions.writeBatchSummary(opts.id, 1, opts.summary, { seqFrom: 1, seqTo: 2 }, [opts.tag]);
    if (opts.secondBatch) {
      await sessions.writeBatchSummary(opts.id, 2, opts.secondBatch, { seqFrom: 3, seqTo: 4 }, [opts.tag]);
    }
    if (opts.rollup) await sessions.updateSessionSummary(opts.id, opts.rollup);
  }

  type JevBody = {
    state: { topic?: string; entries?: string[]; [key: string]: unknown };
    questions: Record<string, { type: string; instructions: string }>;
  };

  function stubJev(
    decide: (body: JevBody) => Record<string, { type: 'noul'; noul: number }> | null,
  ): JevBody[] {
    const calls: JevBody[] = [];
    process.env.JEV_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as JevBody;
      calls.push(body);
      const answers = decide(body);
      if (!answers) return new Response('no', { status: 503 });
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return calls;
  }

  it('matches today byte for byte when Jev does not answer', async () => {
    await seedSession({
      id: 'and-hit', date: '2026-01-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha and bravo both named here',
      rollup: 'alpha and bravo both named here',
    });
    await seedSession({
      id: 'or-only', date: '2026-02-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha alone is not the phrase',
      rollup: 'alpha alone is not the phrase',
    });

    const without = formatTopicResume(await collectTopicResume(store, 'P0084', 'alpha-bravo'));
    expect(without).toContain('and-hit');
    expect(without).not.toContain('or-only');

    process.env.JEV_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const failed = formatTopicResume(await collectTopicResume(store, 'P0084', 'alpha-bravo'));
    expect(failed).toBe(without);
  });

  it('keeps an OR-only session at noul 0.9 and drops one at 0.5', async () => {
    await seedSession({
      id: 'keep-or', date: '2026-03-01T10:00:00.000Z', tag: '#other',
      summary: 'batch text must not be what Jev sees',
      rollup: 'KEEPME alpha widens this session',
    });
    await seedSession({
      id: 'drop-or', date: '2026-04-01T10:00:00.000Z', tag: '#other',
      summary: 'bravo mentioned once',
      rollup: 'DROPME bravo widens this session',
    });
    await seedSession({
      id: 'border', date: '2026-05-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha border',
      rollup: 'BORDER alpha at the threshold',
    });

    const calls = stubJev(body => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      (body.state.entries ?? []).forEach((entry, n) => {
        const noul = entry.includes('KEEPME') ? 0.9 : entry.includes('BORDER') ? 0.75 : 0.5;
        answers[`e${n}`] = { type: 'noul', noul };
      });
      return answers;
    });

    const topic = await collectTopicResume(store, 'P0084', 'alpha-bravo');
    expect(topic.sessions.map(s => s.sessionId).sort()).toEqual(['border', 'keep-or']);

    expect(calls.length).toBeGreaterThan(0);
    const body = calls[0]!;
    expect(Object.keys(body.state).sort()).toEqual(['entries', 'topic']);
    expect(body.state.topic).toBe('alpha-bravo');
    expect(body.state.entries!.some(e => /^E\d+: /.test(e) && e.includes('KEEPME'))).toBe(true);
    expect(body.state.entries!.some(e => e.includes('batch text must not be what Jev sees'))).toBe(false);
    expect(body.questions.e0).toEqual({
      type: 'noul',
      instructions: 'Is entry E0 about the topic?',
    });
  });

  it('keeps tag and AND sessions without sending them when Jev scores 0.1', async () => {
    await seedSession({
      id: 'tag-hit', date: '2026-01-01T10:00:00.000Z', tag: '#recall-banana',
      summary: 'TAGONLY prose with neither word',
      rollup: 'TAGONLY prose with neither word',
    });
    await seedSession({
      id: 'and-hit', date: '2026-02-01T10:00:00.000Z', tag: '#other',
      summary: 'recall and banana in the body',
      rollup: 'ANDONLY recall and banana in the body',
    });
    await seedSession({
      id: 'or-hit', date: '2026-03-01T10:00:00.000Z', tag: '#other',
      summary: 'banana only',
      rollup: 'ORONLY banana once',
    });

    const calls = stubJev(body => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      (body.state.entries ?? []).forEach((_, n) => {
        answers[`e${n}`] = { type: 'noul', noul: 0.1 };
      });
      return answers;
    });

    const topic = await collectTopicResume(store, 'P0084', 'recall-banana');
    expect(topic.sessions.map(s => s.sessionId).sort()).toEqual(['and-hit', 'tag-hit']);

    const sent = calls.flatMap(c => c.state.entries ?? []).join('\n');
    expect(sent).toContain('ORONLY');
    expect(sent).not.toContain('TAGONLY');
    expect(sent).not.toContain('ANDONLY');
  });

  it('does not OR the generic token session in "session binding"', async () => {
    await seedSession({
      id: 'binding-only', date: '2026-02-01T10:00:00.000Z', tag: '#other',
      summary: 'the binding table was rewritten',
      rollup: 'BINDINGONLY the binding table was rewritten',
    });
    // #session-summary tokenizes to "session", so an untouched binding summary
    // is already an AND hit and never reaches the OR path this test is about.
    const summary = (await findChildByKind(store, 'binding-only', KIND_SUMMARY_ROOT))!;
    await store.update(summary.id, { tags: ['#other'] });
    for (const batch of await store.getChildByKind(summary.id, KIND_BATCH)) {
      await store.update(batch.id, { tags: ['#other'] });
    }
    await seedSession({
      id: 'session-only', date: '2026-03-01T10:00:00.000Z', tag: '#other',
      summary: 'the session started cleanly',
      rollup: 'SESSIONONLY the session started cleanly',
    });

    const calls = stubJev(body => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      (body.state.entries ?? []).forEach((_, n) => {
        answers[`e${n}`] = { type: 'noul', noul: 0.9 };
      });
      return answers;
    });

    const topic = await collectTopicResume(store, 'P0084', 'session binding');
    expect(topic.sessions.map(s => s.sessionId)).toEqual(['binding-only']);
    const sent = calls.flatMap(c => c.state.entries ?? []).join('\n');
    expect(sent).toContain('BINDINGONLY');
    expect(sent).not.toContain('SESSIONONLY');
    expect(sent.toLowerCase()).not.toMatch(/\bsession\b/);
  });

  it('drops a chunk whose reply is null and still keeps a scored chunk', async () => {
    for (let n = 0; n < 9; n++) {
      const id = `jev-${String(n).padStart(2, '0')}`;
      await seedSession({
        id, date: `2026-01-${String(n + 1).padStart(2, '0')}T10:00:00.000Z`, tag: '#other',
        summary: `${id} alpha only`,
        rollup: `${id} alpha only`,
      });
    }

    const calls = stubJev(body => {
      const entries = body.state.entries ?? [];
      if (entries.length < 8) return null;
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      entries.forEach((_, n) => {
        answers[`e${n}`] = { type: 'noul', noul: 0.9 };
      });
      return answers;
    });

    const topic = await collectTopicResume(store, 'P0084', 'alpha-bravo');
    const dropped = calls
      .filter(c => (c.state.entries ?? []).length < 8)
      .flatMap(c => c.state.entries ?? [])
      .join('\n');
    expect(calls.some(c => (c.state.entries ?? []).length === 8)).toBe(true);
    expect(calls.some(c => (c.state.entries ?? []).length < 8)).toBe(true);
    for (const call of calls) {
      expect(Object.keys(call.questions).sort()).toEqual(
        (call.state.entries ?? []).map((_, n) => `e${n}`).sort(),
      );
    }
    for (const id of topic.sessions.map(s => s.sessionId)) {
      expect(dropped).not.toContain(id);
    }
    expect(topic.sessions).toHaveLength(8);
    expect(topic.sessionsMatched).toBe(8);
  });

  it('counts only kept sessions in the rendered-of-matched line', async () => {
    await seedSession({
      id: 'and-hit', date: '2026-01-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha bravo baseline',
      rollup: 'alpha bravo baseline',
    });
    await seedSession({
      id: 'keep-a', date: '2026-02-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha keep a',
      rollup: 'KEEPA alpha',
    });
    await seedSession({
      id: 'keep-b', date: '2026-03-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha keep b',
      rollup: 'KEEPB alpha',
    });
    await seedSession({
      id: 'drop-c', date: '2026-04-01T10:00:00.000Z', tag: '#other',
      summary: 'alpha drop c',
      rollup: 'DROPC alpha',
    });

    stubJev(body => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      (body.state.entries ?? []).forEach((entry, n) => {
        answers[`e${n}`] = { type: 'noul', noul: entry.includes('DROPC') ? 0.5 : 0.9 };
      });
      return answers;
    });

    const topic = await collectTopicResume(store, 'P0084', 'alpha-bravo', 2);
    expect(topic.sessionsMatched).toBe(3);
    expect(formatTopicResume(topic)).toContain('Newest 2 of 3 matching sessions');
    expect(formatTopicResume(topic)).not.toContain('drop-c');
  });

  it('sends the rollup truncated to 550 chars, or the first batch when there is no rollup', async () => {
    const tail = 'TAILMARKER';
    const rollup = `${'r'.repeat(540)} alpha ${tail}`;
    expect(rollup.length).toBeGreaterThan(550);
    await seedSession({
      id: 'long', date: '2026-01-01T10:00:00.000Z', tag: '#other',
      summary: 'short batch alpha',
      rollup,
    });
    await seedSession({
      id: 'bare', date: '2026-02-01T10:00:00.000Z', tag: '#other',
      summary: 'FIRSTBATCH alpha earliest',
      secondBatch: 'SECONDBATCH alpha later',
    });

    const calls = stubJev(body => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      (body.state.entries ?? []).forEach((_, n) => {
        answers[`e${n}`] = { type: 'noul', noul: 0.9 };
      });
      return answers;
    });

    await collectTopicResume(store, 'P0084', 'alpha-bravo');
    const entries = calls.flatMap(c => c.state.entries ?? []);
    const long = entries.find(e => e.includes('rrr'));
    const longBody = long?.match(/^E\d+: ([\s\S]*)$/)?.[1];
    expect(longBody).toHaveLength(550);
    expect(longBody).not.toContain(tail);
    expect(entries.some(e => e.includes('short batch'))).toBe(false);
    const bare = entries.find(e => e.includes('FIRSTBATCH'));
    expect(bare).toBeDefined();
    expect(entries.some(e => e.includes('SECONDBATCH'))).toBe(false);
  });
});
