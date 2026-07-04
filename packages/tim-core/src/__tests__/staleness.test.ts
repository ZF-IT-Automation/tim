import { describe, it, expect } from 'vitest';
import { isStale, daysSinceLastVerified } from '../staleness.js';
import type { Entry } from '../index.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-07-04T12:00:00.000Z');

function entryAt(daysAgo: number, overrides: Partial<Entry> = {}): Entry {
  const last = new Date(NOW - daysAgo * DAY_MS).toISOString();
  return {
    id: 'x'.repeat(26),
    parentId: null,
    title: 'Fact',
    content: 'body',
    contentType: 'text',
    depth: 1,
    confidence: 1,
    createdAt: last,
    accessedAt: last,
    updatedAt: last,
    decayRate: 0,
    visibility: 1,
    tags: [],
    irrelevant: false,
    favorite: false,
    tombstonedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe('isStale', () => {
  it('returns false at 89 days', () => {
    expect(isStale(entryAt(89), 90, NOW)).toBe(false);
  });

  it('returns false at exactly 90 days (floor boundary)', () => {
    expect(isStale(entryAt(90), 90, NOW)).toBe(false);
    expect(daysSinceLastVerified(entryAt(90), NOW)).toBe(90);
  });

  it('returns true at 91 days', () => {
    expect(isStale(entryAt(91), 90, NOW)).toBe(true);
  });

  it('prefers metadata.verified_at over updatedAt', () => {
    const old = new Date(NOW - 200 * DAY_MS).toISOString();
    const recent = new Date(NOW - 1 * DAY_MS).toISOString();
    const entry = entryAt(200, {
      metadata: { verified_at: recent },
      createdAt: old,
      updatedAt: old,
      accessedAt: old,
    });
    expect(isStale(entry, 90, NOW)).toBe(false);
  });
});
