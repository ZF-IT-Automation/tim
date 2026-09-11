import { describe, it, expect } from 'vitest';
import {
  estimateTextTokens,
  validateTokenBudget,
  boundRenderedText,
  clampBriefingDefaultBudget,
  MAX_TOKEN_BUDGET,
  BRIEFING_TRUNCATION_MARKER,
  byteBudgetToHookMaxTokens,
} from '../briefing-budget.js';
import { selectBriefingBlocks, type BriefingBlock } from '../task-aware-selection.js';

describe('briefing-budget', () => {
  it('estimates tokens from UTF-8 bytes conservatively', () => {
    expect(estimateTextTokens('abcd')).toBe(4);
    expect(estimateTextTokens('hello world')).toBe(11);
    // Use every UTF-8 byte, never assume four bytes fit in one model token.
    expect(estimateTextTokens('🙂🙂🙂🙂')).toBe(16);
    // German umlaut uses two bytes per character
    expect(estimateTextTokens('über')).toBe(5);
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

  it('appends the documented truncation marker for normal budgets', () => {
    const bounded = boundRenderedText('x'.repeat(200), 50);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain(BRIEFING_TRUNCATION_MARKER);
  });

  it('converts MCP byte budgets to hook maxTokens units', () => {
    expect(byteBudgetToHookMaxTokens(9000)).toBe(2250);
    expect(byteBudgetToHookMaxTokens(0)).toBe(0);
  });

  it('reports the actual bounded size for every tiny Unicode budget', () => {
    for (let budget = 1; budget <= 32; budget++) {
      const bounded = boundRenderedText('🙂中über'.repeat(20), budget);
      expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(budget);
      expect(bounded.estimatedTokens).toBe(Buffer.byteLength(bounded.text, 'utf8'));
      expect(bounded.text).not.toContain('\uFFFD');
    }
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
    const { included, ledger } = selectBriefingBlocks(blocks, 2);
    expect(included).toHaveLength(1);
    expect(included[0]!.lines).toEqual(['Hi']);
    expect(ledger.used).toBeLessThanOrEqual(2);
    expect(included[0]!.lines.join('\n')).not.toContain('second line');
  });

  it('retains first non-empty heading after leading blank spacers', () => {
    const blocks: BriefingBlock[] = [
      { id: 'header', priority: 0, order: 0, lines: ['H'.repeat(50)] },
      {
        id: 'big',
        priority: 3,
        order: 10,
        lines: ['', '── important ──', 'X'.repeat(500)],
      },
    ];
    const { included, omissions } = selectBriefingBlocks(blocks, 100);
    expect(included.map(b => b.id)).toEqual(['header', 'big']);
    expect(included[1]!.lines).toContain('── important ──');
    expect(omissions.some(o => o.includes('big'))).toBe(true);
    expect(included[1]!.lines.join('\n')).not.toContain('X'.repeat(500));
  });
});
