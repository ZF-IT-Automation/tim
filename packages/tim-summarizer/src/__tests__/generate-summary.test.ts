import { describe, it, expect } from 'vitest';
import { generateSummaryHeuristic } from '../generate-summary.js';
import type { UnsummarizedBatch } from '../mcp-client.js';

const baseBatch: UnsummarizedBatch = {
  sessionId: 's1',
  summaryNodeId: 'sum',
  exchangesNodeId: 'ex',
  batchIndex: 1,
  batchSize: 2,
  exchanges: [
    { seq: 1, userId: 'u1', userContent: 'Hello', agentId: 'a1', agentContent: 'Hi' },
    { seq: 2, userId: 'u2', userContent: 'Bye', agentId: 'a2', agentContent: 'Later' },
  ],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: { project: 'P0001' },
};

describe('generateSummaryHeuristic', () => {
  it('includes batch index and exchange bodies', () => {
    const text = generateSummaryHeuristic(baseBatch);
    expect(text).toContain('Batch 1');
    expect(text).toContain('Hello');
    expect(text).toContain('Hi');
    expect(text).toContain('project=P0001');
  });
});
