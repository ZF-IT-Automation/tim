// TimStore batch helpers — entryExistsBatch + getRecentBatchSummaries

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import { SessionManager } from '../session.js';
import { KIND_BATCH } from '../session-tree.js';

let store: TimStore;
let sessions: SessionManager;

beforeEach(() => {
  store = new TimStore(':memory:');
  sessions = new SessionManager(store);
});

afterEach(() => {
  store.close();
});

async function seedBatchSummaries(count: number, projectId = 'P0200'): Promise<void> {
  await store.createProject(projectId);
  for (let i = 1; i <= count; i++) {
    const sessionId = `sess-batch-${projectId}-${i}`;
    await sessions.startProjectSession({
      sessionId,
      projectId,
      agentName: 'test',
      cwd: '/',
      harness: 'vitest',
      batchSize: 2,
    });
    await sessions.logExchange(sessionId, [
      { role: 'user', content: `Q${i}` },
      { role: 'agent', content: `A${i}` },
    ]);
    await sessions.writeBatchSummary(sessionId, 1, `summary ${i}`, { seqFrom: 1, seqTo: 1 });
  }
}

describe('entryExistsBatch', () => {
  it('returns empty Set for empty input', async () => {
    const result = await store.entryExistsBatch([]);
    expect(result.size).toBe(0);
  });

  it('returns empty Set when no ids exist', async () => {
    const result = await store.entryExistsBatch(['nonexistent']);
    expect(result.size).toBe(0);
  });

  it('returns only existing id when mixed with nonexistent', async () => {
    const entry = await store.write('exists');
    const result = await store.entryExistsBatch([entry.id, 'nonexistent']);
    expect(result.size).toBe(1);
    expect(result.has(entry.id)).toBe(true);
  });

  it('returns Set of all existing ids from a larger batch', async () => {
    const e1 = await store.write('one');
    const e2 = await store.write('two');
    const result = await store.entryExistsBatch([e1.id, 'missing', e2.id, 'also-missing']);
    expect(result.size).toBe(2);
    expect(result.has(e1.id)).toBe(true);
    expect(result.has(e2.id)).toBe(true);
  });
});

describe('getRecentBatchSummaries', () => {
  it('returns at most limit entries with batch-summary kind and session-summary tag', async () => {
    await seedBatchSummaries(7);

    const results = await store.getRecentBatchSummaries({ limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results.length).toBe(5);
    for (const entry of results) {
      expect(entry.metadata.kind).toBe(KIND_BATCH);
      expect(entry.tags).toContain('#session-summary');
    }
  });

  it('returns empty when maxAgeDays is 0', async () => {
    await seedBatchSummaries(3);

    const results = await store.getRecentBatchSummaries({ maxAgeDays: 0 });
    expect(results).toEqual([]);
  });

  it('filters by sessionId when provided', async () => {
    await seedBatchSummaries(3);
    const targetSession = 'sess-batch-P0200-2';

    const results = await store.getRecentBatchSummaries({ sessionId: targetSession, limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.metadata.sessionId).toBe(targetSession);
  });

  it('filters by project root when provided', async () => {
    await seedBatchSummaries(2, 'P0201');
    await seedBatchSummaries(2, 'P0202');

    const results = await store.getRecentBatchSummaries({ root: 'P0201', limit: 10 });
    expect(results.length).toBe(2);
    for (const entry of results) {
      expect(store.getProjectLabel(entry.id)).toBe('P0201');
    }
  });
});
