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
    // Verbatim reuse, not merely "a fitting tag": respellings of an agreed tag
    // split the topic exactly as badly as inventing a new one.
    expect(prompt).toMatch(/use it verbatim/);
  });

  // Criterion 2: a vocabulary lookup that fails must cost nothing. Both the
  // missing and the empty case have to produce the same prompt, or a failed
  // lookup would silently change how sessions get summarized.
  it('asks for tags identically whether the vocabulary is missing or empty', () => {
    const withoutField = buildPrompt(base);
    const withEmpty = buildPrompt({ ...base, vocabulary: [] });

    expect(withoutField).toBe(withEmpty);
    expect(withoutField).not.toMatch(/already reuses/);
    expect(withoutField).toContain('(1-3 content hashtags, lowercase kebab-case, # prefix)');
  });

  it('still asks for the TAGS line when a vocabulary is present', () => {
    const prompt = buildPrompt({ ...base, vocabulary: ['#sync'] });
    expect(prompt).toContain('End your response with a line: TAGS:');
  });

  // The rule the tags are actually judged by. Without this the instruction is a
  // sentence in a string literal that any later edit can quietly soften.
  it('names what a tag is and what it is not', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('feature, subsystem or subject');
    for (const counterExample of ['#testing', '#queue', '#tim']) {
      expect(prompt).toContain(counterExample);
    }
  });
});
