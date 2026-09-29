import { describe, it, expect } from 'vitest';
import {
  aggregate,
  identifiers,
  isEnglish,
  parseTokens,
  pickWinner,
  scoreOutput,
  type CallResult,
  type EvalCase,
} from '../eval-summarizer.js';

const batchCase: EvalCase = {
  id: 'batch/x', kind: 'batch',
  mustKeep: [['cwd'], ['stable dir', 'homedir']],
  batch: {
    sessionId: 's', summaryNodeId: '', exchangesNodeId: '', batchIndex: 1, batchSize: 1, hasMore: false,
    previousSummaries: [], sessionMeta: {},
    exchanges: [{ seq: 1, userId: 'u', userContent: 'fix spawn cwd in packages/tim-summarizer/src/generate-summary.ts',
      agentId: 'a', agentContent: 'fixed in 4c589f0, spawn now uses homedir' }],
  },
};

describe('eval-summarizer scoring', () => {
  it('scores a compliant batch output', () => {
    const out = '- Summarizer spawned with a deleted cwd; now spawns in the homedir (4c589f0).\n' +
      'SUBSTANCE: real\nTAGS: #summarizer #debugging';
    const s = scoreOutput(batchCase, out);
    expect(s.violations).toEqual([]);
    expect(s.english).toBe(true);
    expect(s.mustKeep).toBe(1);
    expect(s.idRecall).toBeCloseTo(1 / 3);
    expect(s.hallucinatedIds).toEqual([]);
  });

  it('flags contract breaks, German output, invented ids and missed facts', () => {
    const out = 'Der Fix ist nicht fertig und die Tests sind auch noch rot, siehe deadbeef1.\n' +
      'TAGS: #tim #decision #design #review';
    const s = scoreOutput(batchCase, out);
    expect(s.violations).toEqual(expect.arrayContaining(['no SUBSTANCE line', '0 subject tags', '2 activity tags']));
    expect(s.english).toBe(false);
    expect(s.hallucinatedIds).toEqual(['deadbeef1']);
    expect(s.missedFacts).toEqual(['cwd', 'stable dir']);
  });

  it('checks rollup bullets and words', () => {
    const c: EvalCase = { id: 'r', kind: 'rollup', batchSummaries: ['x'], mustKeep: [] };
    expect(scoreOutput(c, 'Here is the rollup:\n- a\n- b').violations)
      .toEqual(['2 bullets', 'preamble']);
  });

  it('finds identifiers', () => {
    expect([...identifiers('P0063 at f2f8662 in docs/a.md and eval.ts, not deadbeef words')])
      .toEqual(expect.arrayContaining(['f2f8662', 'P0063', 'docs/a.md', 'eval.ts']));
    expect(isEnglish('the fix is in and the tests are green')).toBe(true);
  });

  it('parses codex token counts', () => {
    expect(parseTokens('codex\nOK\ntokens used\n6,796\nOK')).toBe(6796);
    expect(parseTokens('plain output')).toBeNull();
  });

  it('picks the cheapest eligible candidate; near-equal costs go to the faster one', () => {
    const score = { contract: true, violations: [], english: true, idRecall: 1, hallucinatedIds: [], mustKeep: 1, missedFacts: [] };
    const r = (candidate: string, tokens: number, latencyMs = 1000, ok = true, mustKeep = 1): CallResult => ({
      candidate, caseId: 'c', kind: 'batch', trial: 1, promptHash: 'h', ok, timedOut: false,
      latencyMs, tokens, output: 'x', score: { ...score, mustKeep },
    });
    // cheap drops facts, flaky fails a call; med beats high on tokens.
    expect(pickWinner(aggregate([
      r('high', 9000), r('cheap', 3000, 1000, true, 0.5), r('med', 5000), r('flaky', 1000, 1000, false),
    ]))?.candidate).toBe('med');
    // 1174 vs 1178 tokens is a tie (within 10 %): the faster one wins.
    expect(pickWinner(aggregate([r('low', 1174, 6700), r('medium', 1178, 6200), r('high', 2363, 7600)]))?.candidate)
      .toBe('medium');
    expect(pickWinner(aggregate([r('flaky', 1000, 1000, false)]))).toBeNull();
  });
});
