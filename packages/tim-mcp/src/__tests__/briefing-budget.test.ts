import { describe, it, expect } from 'vitest';
import {
  estimateTextTokens,
  validateTokenBudget,
  boundRenderedText,
  clampBriefingDefaultBudget,
  MAX_TOKEN_BUDGET,
} from '../briefing-budget.js';
import { selectBriefingBlocks, type BriefingBlock } from '../task-aware-selection.js';

describe('briefing-budget', () => {
  it('estimates tokens from UTF-8 bytes conservatively', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('hello world')).toBe(3);
    // Four emoji = 16 UTF-8 bytes → 4 estimated tokens (not 1 from code points)
    expect(estimateTextTokens('🙂🙂🙂🙂')).toBe(4);
    // German umlaut uses two bytes per character
    expect(estimateTextTokens('über')).toBe(2);
  });

  it('validates tokenBudget overrides including config default 9000', () => {
    expect(validateTokenBudget(undefined, 9000)).toEqual({ ok: true, value: 9000 });
    expect(validateTokenBudget(9000, 9000)).toEqual({ ok: true, value: 9000 });
    expect(validateTokenBudget(500, 9000)).toEqual({ ok: true, value: 500 });
    expect(validateTokenBudget(0, 9000).ok).toBe(false);
    expect(validateTokenBudget(-1, 9000).ok).toBe(false);
    expect(validateTokenBudget(Number.NaN, 9000).ok).toBe(false);
    expect(validateTokenBudget(1.5, 9000).ok).toBe(false);
    expect(validateTokenBudget(Number.POSITIVE_INFINITY, 9000).ok).toBe(false);
    expect(validateTokenBudget(MAX_TOKEN_BUDGET + 1, 9000).ok).toBe(false);
  });

  it('clamps invalid configured defaults', () => {
    expect(clampBriefingDefaultBudget(9000)).toBe(9000);
    expect(clampBriefingDefaultBudget(Number.NaN)).toBe(9000);
    expect(clampBriefingDefaultBudget(999999)).toBe(MAX_TOKEN_BUDGET);
  });

  it('bounds tiny Unicode output explicitly', () => {
    const text = '🙂'.repeat(40);
    const bounded = boundRenderedText(text, 5);
    expect(bounded.truncated).toBe(true);
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(5);
    expect(bounded.text).toMatch(/…/);
  });

  it('bounds large Unicode bodies without O(n²) blow-up', () => {
    const text = 'A'.repeat(8000) + '🙂'.repeat(2000);
    const start = Date.now();
    const bounded = boundRenderedText(text, 100);
    expect(Date.now() - start).toBeLessThan(500);
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(100);
    expect(bounded.text.length).toBeLessThan(text.length);
  });
});

describe('selectBriefingBlocks partial inclusion', () => {
  it('returns trimmed block text matching charged budget', () => {
    const blocks: BriefingBlock[] = [{
      id: 'multi',
      priority: 4,
      order: 1,
      lines: ['Hi', 'second line should not appear', 'third either'],
    }];
    const { included, ledger } = selectBriefingBlocks(blocks, 1);
    expect(included).toHaveLength(1);
    expect(included[0]!.lines).toEqual(['Hi']);
    expect(ledger.used).toBeLessThanOrEqual(1);
    expect(included[0]!.lines.join('\n')).not.toContain('second line');
  });
});
