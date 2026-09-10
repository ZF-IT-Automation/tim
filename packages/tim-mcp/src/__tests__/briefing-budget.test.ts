import { describe, it, expect } from 'vitest';
import {
  estimateTextTokens,
  validateTokenBudget,
  boundRenderedText,
  MAX_TOKEN_BUDGET_PARAM,
} from '../briefing-budget.js';

describe('briefing-budget', () => {
  it('estimates tokens from Unicode code points conservatively', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('hello world')).toBe(3);
    expect(estimateTextTokens('🙂🙂🙂🙂')).toBe(1);
  });

  it('validates tokenBudget overrides', () => {
    expect(validateTokenBudget(undefined, 9000)).toEqual({ ok: true, value: 9000 });
    expect(validateTokenBudget(500, 9000)).toEqual({ ok: true, value: 500 });
    expect(validateTokenBudget(0, 9000).ok).toBe(false);
    expect(validateTokenBudget(-1, 9000).ok).toBe(false);
    expect(validateTokenBudget(Number.NaN, 9000).ok).toBe(false);
    expect(validateTokenBudget(1.5, 9000).ok).toBe(false);
    expect(validateTokenBudget(MAX_TOKEN_BUDGET_PARAM + 1, 9000).ok).toBe(false);
  });

  it('bounds tiny Unicode output explicitly', () => {
    const text = '🙂'.repeat(40);
    const bounded = boundRenderedText(text, 5);
    expect(bounded.truncated).toBe(true);
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(5);
  });
});
