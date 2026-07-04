import { describe, it, expect } from 'vitest';
import { annotateTrust } from '../trust.js';
import type { Entry } from 'tim-core';

function entryFixture(overrides: Partial<Entry>): Entry {
  const now = new Date().toISOString();
  return {
    id: 'x'.repeat(26),
    parentId: null,
    title: 'Fact',
    content: 'body',
    contentType: 'text',
    depth: 1,
    confidence: 1,
    createdAt: now,
    accessedAt: now,
    updatedAt: now,
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

describe('annotateTrust — staleness', () => {
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();

  it('marks unverified old knowledge entries stale', () => {
    const out = annotateTrust(entryFixture({ createdAt: old, updatedAt: old }), process.cwd());
    expect(out.stale).toBeDefined();
    expect(out.stale!.daysSince).toBeGreaterThan(90);
    expect(out.stale!.lastVerified).toBe(old);
  });

  it('respects a recent metadata.verified_at', () => {
    const out = annotateTrust(
      entryFixture({
        createdAt: old,
        updatedAt: old,
        metadata: { verified_at: new Date().toISOString() },
      }),
      process.cwd(),
    );
    expect(out.stale).toBeUndefined();
  });

  it('never marks schema entries stale', () => {
    const out = annotateTrust(
      entryFixture({ createdAt: old, updatedAt: old, metadata: { kind: 'session' } }),
      process.cwd(),
    );
    expect(out.stale).toBeUndefined();
  });
});
