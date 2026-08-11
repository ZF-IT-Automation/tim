import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../generate-summary.js';
import type { UnsummarizedBatch } from '../mcp-client.js';

const base: UnsummarizedBatch = {
  sessionId: 's1',
  summaryNodeId: 'sum1',
  exchangesNodeId: 'ex1',
  batchIndex: 1,
  batchSize: 5,
  exchanges: [{ seq: 1, userId: 'u1', userContent: 'Q', agentId: 'a1', agentContent: 'A' }],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: { project: 'P0063' },
};

describe('buildPrompt vocabulary hint (criteria 1 + 2)', () => {
  it('carries the whole vocabulary, in the order it was given', () => {
    const prompt = buildPrompt({ ...base, vocabulary: ['#sync', '#schema', '#rare'] });
    expect(prompt).toContain('#sync #schema #rare');
    expect(prompt).toMatch(/[Rr]euse a fitting existing tag/);
  });

  // Criterion 2: a vocabulary lookup that fails must cost nothing. Both the
  // missing and the empty case have to produce the pre-feature prompt exactly,
  // or a failed lookup would silently change how sessions get summarized.
  it('falls back to the old prompt verbatim when there is no vocabulary', () => {
    const withoutField = buildPrompt(base);
    const withEmpty = buildPrompt({ ...base, vocabulary: [] });

    expect(withoutField).toBe(withEmpty);
    expect(withoutField).not.toMatch(/already uses these tags/);
    expect(withoutField.endsWith(
      'End your response with a line: TAGS: #tag1 #tag2 ... (3-5 content hashtags, lowercase kebab-case, # prefix).',
    )).toBe(true);
  });

  it('still asks for the TAGS line when a vocabulary is present', () => {
    const prompt = buildPrompt({ ...base, vocabulary: ['#sync'] });
    expect(prompt).toContain('End your response with a line: TAGS:');
  });
});
