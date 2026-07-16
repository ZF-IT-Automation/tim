import { describe, it, expect } from 'vitest';
import { isCodingNeedsReview } from '../idea-promote.js';

describe('isCodingNeedsReview', () => {
  it('returns true for coding task with commits and not reviewed', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: ['abc123'], reviewed: false },
      }),
    ).toBe(true);
  });

  it('returns false when reviewed is true', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: ['abc123'], reviewed: true },
      }),
    ).toBe(false);
  });

  it('returns false when commits array is empty', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: [], reviewed: false },
      }),
    ).toBe(false);
  });

  it('returns false when subtype is missing', () => {
    expect(
      isCodingNeedsReview({
        task: { commits: ['abc123'], reviewed: false },
      }),
    ).toBe(false);
  });
});
