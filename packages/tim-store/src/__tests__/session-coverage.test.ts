import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager, deriveSessionCoverage } from '../index.js';

describe('deriveSessionCoverage', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0100');
  });

  afterEach(() => {
    store.close();
  });

  it('reports uncovered tail after partial batch summary', async () => {
    await sessions.startProjectSession({
      sessionId: 'partial',
      projectId: 'P0100',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('partial', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'agent', content: 'A2' },
    ]);
    await sessions.writeBatchSummary('partial', 1, 'partial draft', { seqFrom: 1, seqTo: 2 });

    await sessions.logExchange('partial', [
      { role: 'user', content: 'Q3' },
      { role: 'agent', content: 'A3' },
      { role: 'user', content: 'Q4' },
      { role: 'agent', content: 'A4' },
    ]);

    const coverage = await deriveSessionCoverage(store, 'partial');
    expect(coverage.exchangeCount).toBe(4);
    expect(coverage.batchesSummarized).toBe(1);
    expect(coverage.hasPendingSummarization).toBe(true);
    expect(coverage.uncovered.map(u => u.seq)).toEqual([3, 4]);
    expect(coverage.coveredRanges).toEqual([
      expect.objectContaining({ batchIndex: 1, seqFrom: 1, seqTo: 2 }),
    ]);
  });

  it('reports no pending work when every exchange is covered', async () => {
    await sessions.startProjectSession({
      sessionId: 'covered',
      projectId: 'P0100',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('covered', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'agent', content: 'A2' },
    ]);
    await sessions.writeBatchSummary('covered', 1, 'done', { seqFrom: 1, seqTo: 2 });

    const coverage = await deriveSessionCoverage(store, 'covered');
    expect(coverage.hasPendingSummarization).toBe(false);
    expect(coverage.uncovered).toEqual([]);
  });

  it('treats missing batch summary as fully uncovered', async () => {
    await sessions.startProjectSession({
      sessionId: 'fresh',
      projectId: 'P0100',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('fresh', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
    ]);

    const coverage = await deriveSessionCoverage(store, 'fresh');
    expect(coverage.hasPendingSummarization).toBe(true);
    expect(coverage.uncovered.map(u => u.seq)).toEqual([1]);
    expect(coverage.coveredRanges).toEqual([]);
  });
});
