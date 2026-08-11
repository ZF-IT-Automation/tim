import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stripDeprecatedTags } from 'tim-core';
import { TimStore, SessionManager, findChildByKind, KIND_SUMMARY_ROOT, KIND_EXCHANGES_ROOT, KIND_EXCHANGE_BATCH } from '../index.js';

describe('handoff note home (acceptance criteria)', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0063', { content: 'handoff home tests' });
  });

  afterEach(() => {
    store.close();
  });

  async function start(id: string) {
    await sessions.startProjectSession({
      sessionId: id,
      projectId: 'P0063',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
    });
    await sessions.logExchange(id, [
      { role: 'user', content: 'hello' },
      { role: 'agent', content: 'hi' },
    ]);
  }

  it('criterion 1–2: checkpoint writes note only on summary root; second replaces first', async () => {
    await start('sess-note');
    await sessions.checkpoint('sess-note', {
      summarize: async () => 'cp1',
      handoffNote: 'first note',
    });
    await sessions.checkpoint('sess-note', {
      summarize: async () => 'cp2',
      handoffNote: 'second note',
    });
    const root = await findChildByKind(store, 'sess-note', KIND_SUMMARY_ROOT);
    expect(root?.metadata.handoff_note).toBe('second note');
    const checkpoints = await store.getChildByKind(root!.id, 'checkpoint');
    for (const cp of checkpoints) {
      expect(cp.metadata.handoff_note).toBeUndefined();
    }
  });

  it('criterion 3: throws when handoff note read-back fails', async () => {
    await start('sess-verify');
    const root = await findChildByKind(store, 'sess-verify', KIND_SUMMARY_ROOT);
    const readImpl = store.read.bind(store);
    const updateImpl = store.update.bind(store);
    let corruptNextRootRead = false;
    vi.spyOn(store, 'update').mockImplementation(async (id, patch) => {
      const result = await updateImpl(id, patch);
      if (
        id === root!.id &&
        patch.metadata &&
        typeof patch.metadata.handoff_note === 'string'
      ) {
        corruptNextRootRead = true;
      }
      return result;
    });
    vi.spyOn(store, 'read').mockImplementation(async (id, opts?) => {
      if (corruptNextRootRead && id === root!.id) {
        corruptNextRootRead = false;
        const entry = await readImpl(id, opts);
        return entry
          ? { ...entry, metadata: { ...entry.metadata, handoff_note: 'wrong' } }
          : entry;
      }
      return readImpl(id, opts);
    });
    await expect(
      sessions.checkpoint('sess-verify', {
        summarize: async () => 'x',
        handoffNote: 'expected',
      }),
    ).rejects.toThrow(/handoff note verification failed/i);
  });

  it('criterion 4: handoff note persists when summarizer throws', async () => {
    await start('sess-no-sum');
    await expect(
      sessions.checkpoint('sess-no-sum', {
        summarize: async () => {
          throw new Error('summarizer down');
        },
        handoffNote: 'survives summarizer failure',
      }),
    ).rejects.toThrow('summarizer down');
    const root = await findChildByKind(store, 'sess-no-sum', KIND_SUMMARY_ROOT);
    expect(root?.metadata.handoff_note).toBe('survives summarizer failure');
  });

  it('criterion 5: resumeSession returns handoffNote when present', async () => {
    await start('sess-resume-note');
    await sessions.checkpoint('sess-resume-note', {
      handoffNote: 'done: a | next: b',
    });
    const payload = await sessions.resumeSession('sess-resume-note', { newHarnessId: 'h-new' });
    expect(payload.handoffNote).toBe('done: a | next: b');
  });

  it('criterion 5: resumeSession omits handoffNote when absent', async () => {
    await start('sess-no-note');
    const payload = await sessions.resumeSession('sess-no-note', { newHarnessId: 'h-new' });
    expect(payload.handoffNote).toBeUndefined();
  });

  it('criterion 6: reap removes checkpoints when rollup exists; keeps without rollup', async () => {
    await start('sess-reap-yes');
    const cp = await sessions.checkpoint('sess-reap-yes', { summarize: async () => 'checkpoint body' });
    await sessions.updateSessionSummary('sess-reap-yes', 'rollup text');

    await start('sess-reap-no');
    const cp2 = await sessions.checkpoint('sess-reap-no', { summarize: async () => 'keep me' });

    const reaped = await sessions.reapCoveredCheckpoints();
    expect(reaped).toBe(1);
    const tombstone = store.getDb().prepare(
      'SELECT tombstoned_at FROM entries WHERE id = ?',
    ).get(cp.id) as { tombstoned_at: string | null };
    expect(tombstone.tombstoned_at).not.toBeNull();
    const edges = await store.getEdges('sess-reap-yes', 'incoming');
    expect(edges.some(e => e.type === 'summarizes')).toBe(false);
    const tombstone2 = store.getDb().prepare(
      'SELECT tombstoned_at FROM entries WHERE id = ?',
    ).get(cp2.id) as { tombstoned_at: string | null };
    expect(tombstone2.tombstoned_at).toBeNull();
  });

  it('criterion 9: fresh session writes no retired structural tags', async () => {
    await start('sess-tags');
    const session = await store.read('sess-tags');
    const root = await findChildByKind(store, 'sess-tags', KIND_SUMMARY_ROOT);
    const exRoot = await findChildByKind(store, 'sess-tags', KIND_EXCHANGES_ROOT);
    const batch = (await store.getChildByKind(exRoot!.id, KIND_EXCHANGE_BATCH))[0];
    const exchanges = await store.getChildrenBySeq(batch!.id);
    const retired = ['#exchange', '#session', '#exchanges', '#checkpoint'];
    for (const entry of [session, root, exRoot, ...exchanges].filter(Boolean)) {
      for (const tag of retired) {
        expect(entry!.tags).not.toContain(tag);
      }
    }
    const cp = await sessions.checkpoint('sess-tags', { summarize: async () => 'body' });
    for (const tag of retired) {
      expect(cp.tags).not.toContain(tag);
    }
    expect(cp.tags).toContain('#session-summary');
    expect(cp.tags).toContain('#batch-summary');
  });

  it('criterion 9: the retired structural tags stay usable as content tags', () => {
    // Nothing emits them automatically any more, but the words are subject matter in
    // this project — a summary about checkpoint reaping must be able to say #checkpoint.
    const { clean, removed } = stripDeprecatedTags([
      '#session-summary',
      '#exchange',
      '#commit',
      '#checkpoint',
      '#todo',
    ]);
    expect(clean).toEqual(['#session-summary', '#exchange', '#commit', '#checkpoint']);
    expect(removed).toEqual(['#todo']);
  });

  it('criterion 9: an explicitly tagged entry keeps a retired structural tag', async () => {
    const entry = await store.write('Checkpoint reaping notes\nbody', {
      tags: ['#checkpoint', '#session'],
    });
    const read = await store.read(entry.id);
    expect(read!.tags).toEqual(['#checkpoint', '#session']);
  });
});
