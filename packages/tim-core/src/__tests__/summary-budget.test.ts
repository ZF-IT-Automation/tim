import { describe, it, expect } from 'vitest';
import {
  BATCH_SUMMARY_MAX_CHARS,
  BATCH_SUMMARY_RENDER_CHARS,
  truncateSummary,
} from '../summary-budget.js';

describe('batch summary budget', () => {
  // The point of the two constants is that they differ: cutting at exactly the
  // budget would truncate summaries that obeyed it, since a model landing on
  // the limit is doing its job. Collapsing them into one number must fail here.
  it('renders past the budget it asks for, so obedience is never punished', () => {
    expect(BATCH_SUMMARY_RENDER_CHARS).toBeGreaterThan(BATCH_SUMMARY_MAX_CHARS);
    const atBudget = 'x'.repeat(BATCH_SUMMARY_MAX_CHARS);
    expect(truncateSummary(atBudget, 'ID1')).toBe(atBudget);
  });

  it('leaves a short summary exactly as it was', () => {
    expect(truncateSummary('- one theme\n- one decision', 'ID1'))
      .toBe('- one theme\n- one decision');
  });

  it('names the id needed to read the rest', () => {
    const long = 'y'.repeat(BATCH_SUMMARY_RENDER_CHARS + 500);
    const cut = truncateSummary(long, 'ID1');
    expect(cut.length).toBeLessThan(long.length);
    expect(cut).toContain('tim_read({ id: "ID1" })');
  });

  // These summaries are bullet lists, and half a bullet states something the
  // whole bullet does not.
  it('cuts on a line boundary rather than mid-bullet', () => {
    const bullets = Array.from({ length: 40 }, (_, i) => `- decision number ${i} was taken`).join('\n');
    const cut = truncateSummary(bullets, 'ID1');
    const body = cut.split('\n  […]')[0]!;
    expect(body.endsWith('taken')).toBe(true);
  });

  // A single unbroken paragraph has no line to cut on; it must still be cut.
  it('still cuts text that contains no newline at all', () => {
    const blob = 'z'.repeat(BATCH_SUMMARY_RENDER_CHARS + 200);
    const cut = truncateSummary(blob, 'ID1');
    expect(cut.length).toBeLessThan(blob.length);
    expect(cut).toContain('[…]');
  });
});

describe('truncateSummary heading handling', () => {
  // A heading with nothing under it asserts something the full text does not:
  // "### Open items" followed by the cut marker reads as "there are none".
  it('drops a heading left dangling by the cut', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `- theme ${i} of this batch`).join('\n');
    const text = `${filler}\n### Offene Punkte\n- the item that got cut`;
    // Cut exactly where the heading would be the last surviving line.
    const at = text.indexOf('### Offene Punkte') + '### Offene Punkte'.length + 1;
    const cut = truncateSummary(text, 'ID1', at);
    expect(cut).not.toContain('### Offene Punkte');
    expect(cut).toContain('[…]');
  });

  it('keeps a heading that still has content under it', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `- theme ${i} of this batch`).join('\n');
    const text = `### Themen\n${filler}\n- the tail that got cut`;
    const cut = truncateSummary(text, 'ID1', 400);
    expect(cut).toContain('### Themen');
  });
});
