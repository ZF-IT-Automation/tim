import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../generate-summary.js';
import { BATCH_SUMMARY_MAX_CHARS } from 'tim-core';
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
    expect(withoutField).toContain('Give 1-3 subject tags');
  });

  it('still asks for the TAGS line when a vocabulary is present', () => {
    const prompt = buildPrompt({ ...base, vocabulary: ['#sync'] });
    expect(prompt).toContain('End your response with a line: TAGS:');
  });

  // Verbatim reuse alone left the widest hole measured: a vocabulary holding
  // both #handoff and #handoff-note fits either way, so the choice came out
  // differently per call and the broad tag stopped finding half its history.
  // Only the vocabulary block can carry this rule — without a list there is no
  // pair to choose between.
  it('says which of two overlapping vocabulary tags to take', () => {
    const prompt = buildPrompt({ ...base, vocabulary: ['#handoff', '#handoff-note'] });
    expect(prompt).toContain('name the same area at different widths');
    expect(prompt).toContain('use exactly one, never both');
    expect(prompt).toContain('Mint at most one tag that is not on the list');
  });

  // The rule the tags are actually judged by. Without this the instruction is a
  // sentence in a string literal that any later edit can quietly soften.
  it('names what a tag is and what it is not', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('Give 1-3 subject tags');
    expect(prompt).toContain('A subject tag names a feature, subsystem or subject');
    for (const counterExample of ['#queue', '#tim']) {
      expect(prompt).toContain(counterExample);
    }
  });

  // The activity facet only stays driftable-proof while the list stays closed
  // and stays named in the prompt. An edit that turns it back into a category
  // ("you may add an activity tag") reopens the #bugfix/#bugfixing families
  // this was measured against, and nothing else would catch that.
  it('offers activity tags only as a closed list of four', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('#design #implementation #debugging #review');
    expect(prompt).toMatch(/Invent no other activity word/);
  });

  // The budget counts subjects only. When the activity competed for the same
  // 1-3 slots it won often enough to matter: 38 of 171 re-tagged summaries came
  // back with one subject and an activity where the original had three or more
  // subjects, so a topic that used to be findable stopped being findable.
  it('puts the activity tag on top of the subject budget, not inside it', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('On top of those you may add one activity tag');
    expect(prompt).toContain('It is an addition, never a replacement');
    // The count must attach to subjects — "1-3 content hashtags" is what made
    // the facet compete in the first place.
    expect(prompt).not.toMatch(/1-3 content hashtags/);
  });
});

describe('batch summary length budget', () => {
  const batch = base;

  it('states the character budget rather than asking vaguely for brevity', () => {
    expect(buildPrompt(batch)).toContain(`under ${BATCH_SUMMARY_MAX_CHARS} characters`);
  });

  // A model told only to be shorter drops whatever is easiest to drop, which is
  // the structured tail — exactly the part the next session reads.
  it('says what to sacrifice first, so decisions and open items survive the cut', () => {
    const prompt = buildPrompt(batch);
    expect(prompt).toMatch(/never a decision or an open item/);
  });
});
