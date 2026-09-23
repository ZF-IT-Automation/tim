import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from '../index.js';

describe('substance aggregation on rollUpSession', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0099');
    await sessions.startProjectSession({
      sessionId: 'sub-roll',
      projectId: 'P0099',
      agentName: 'a',
      cwd: '/tmp/sub-roll',
      harness: 't',
      batchSize: 2,
    });
    await sessions.logExchange('sub-roll', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'agent', content: 'A2' },
    ]);
  });

  afterEach(() => {
    store.close();
  });

  it('aggregates max substance onto summary-root metadata', async () => {
    await sessions.writeBatchSummary('sub-roll', 1, 'minor', { seqFrom: 1, seqTo: 1 }, undefined, 'low');
    await sessions.writeBatchSummary('sub-roll', 2, 'real work', { seqFrom: 2, seqTo: 2 }, undefined, 'real');
    const summary = await sessions.rollUpSession('sub-roll', async batches =>
      batches.map(b => b.content).join('\n'),
    );
    expect(summary.metadata.substance).toBe('real');
  });

  it('leaves substance unset when batches have none', async () => {
    await sessions.writeBatchSummary('sub-roll', 1, 'legacy batch', { seqFrom: 1, seqTo: 2 });
    const summary = await sessions.rollUpSession('sub-roll', async batches =>
      batches.map(b => b.content).join('\n'),
    );
    expect(summary.metadata.substance).toBeUndefined();
  });
});
