import { describe, it, expect } from 'vitest';
import {
  generateSummaryHeuristic,
  extractTags,
  FALLBACK_MARKER,
} from '../generate-summary.js';
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

describe('extractTags', () => {
  it('parses TAGS line, normalizes, dedups, caps at 5', () => {
    const text =
      'Themes: auth work\n- decided JWT\n\nTAGS: #Auth #auth #session-start #FOO_BAR #one #two #three #four #five #six';
    const { body, tags } = extractTags(text);
    expect(body).toBe('Themes: auth work\n- decided JWT');
    expect(tags).toEqual(['#auth', '#session-start', '#foo-bar', '#one', '#two']);
  });

  it('returns empty tags when TAGS line missing', () => {
    const { body, tags } = extractTags('Summary only');
    expect(body).toBe('Summary only');
    expect(tags).toEqual([]);
  });

  it('returns empty tags for FALLBACK_MARKER', () => {
    const { body, tags } = extractTags(FALLBACK_MARKER);
    expect(body).toBe(FALLBACK_MARKER);
    expect(tags).toEqual([]);
  });
});
