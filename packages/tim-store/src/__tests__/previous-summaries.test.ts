import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from '../index.js';

const PROJECT = 'P0200';
const SESSION = 'sess-prev';

describe('showUnsummarized previousSummaries', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject(PROJECT);
    await sessions.startProjectSession({
      sessionId: SESSION,
      projectId: PROJECT,
      agentName: 'agent',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });
  });

  afterEach(() => {
    store.close();
  });

  async function logPair(n: number): Promise<void> {
    await sessions.logExchange(SESSION, [
      { role: 'user', content: `Q${n}` },
      { role: 'agent', content: `A${n}` },
    ]);
  }

  it('carries batch summary bodies, not the "Batch N" titles', async () => {
    await logPair(1);
    await logPair(2);
    const first = await sessions.showUnsummarized(SESSION);
    expect(first.previousSummaries).toEqual([]);
    await sessions.writeBatchSummary(SESSION, first.batchIndex, 'auth refactor themes', {
      seqFrom: 1,
      seqTo: 2,
    });

    await logPair(3);
    await logPair(4);
    const second = await sessions.showUnsummarized(SESSION);

    expect(second.batchIndex).toBe(2);
    expect(second.previousSummaries).toEqual(['auth refactor themes']);
    expect(second.previousSummaries.some(s => /^Batch \d+$/.test(s))).toBe(false);
  });

  it('returns summaries in batch order', async () => {
    await logPair(1);
    await logPair(2);
    await sessions.writeBatchSummary(SESSION, 1, 'first themes', { seqFrom: 1, seqTo: 2 });
    await logPair(3);
    await logPair(4);
    await sessions.writeBatchSummary(SESSION, 2, 'second themes', { seqFrom: 3, seqTo: 4 });

    await logPair(5);
    await logPair(6);
    const third = await sessions.showUnsummarized(SESSION);
    expect(third.previousSummaries).toEqual(['first themes', 'second themes']);
  });

  it('excludes checkpoint nodes, which share the batch summary tags', async () => {
    await logPair(1);
    await logPair(2);
    await sessions.writeBatchSummary(SESSION, 1, 'real batch themes', { seqFrom: 1, seqTo: 2 });
    await sessions.checkpoint(SESSION, { summarize: async () => 'checkpoint handoff text' });

    await logPair(3);
    await logPair(4);
    const next = await sessions.showUnsummarized(SESSION);
    expect(next.previousSummaries).toEqual(['real batch themes']);
  });
});
