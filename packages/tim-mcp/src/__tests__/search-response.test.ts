import { describe, expect, it, vi } from 'vitest';
import type { Entry } from 'tim-core';
import { buildBoundedSearchResponse } from '../search-response.js';

const MAX_SEARCH_TITLE_CODE_POINTS = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_CODE_POINTS = 64;
const MAX_SEARCH_METADATA_STRING_CODE_POINTS = 128;
const SEARCH_RESPONSE_MIN_BYTES = 128;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: '01SEARCHRESULT000000000000',
    parentId: null,
    title: 'Result',
    content: '',
    contentType: 'text',
    depth: 1,
    confidence: 1,
    createdAt: '2026-07-16T00:00:00.000Z',
    accessedAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
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

describe('buildBoundedSearchResponse', () => {
  it('stops excerpt iteration at the limit instead of materializing the whole body', () => {
    const body = '😀'.repeat(10_000);
    const arrayFrom = vi.spyOn(Array, 'from');
    try {
      const response = buildBoundedSearchResponse([entry({ content: body })]);
      expect(response.results[0]?.excerpt).toHaveLength(999);
      expect(arrayFrom.mock.calls.some(([value]) => value === body)).toBe(false);
    } finally {
      arrayFrom.mockRestore();
    }
  });

  it('caps pathological title, tags, and task metadata deterministically', () => {
    const response = buildBoundedSearchResponse([entry({
      title: '😀'.repeat(10_000),
      tags: Array.from({ length: 100 }, (_, i) => `#${i}-${'😀'.repeat(500)}`),
      metadata: {
        kind: '😀'.repeat(1_000),
        task: {
          status: '😀'.repeat(1_000),
          priority: 'high',
          completion_evidence: 'verified by focused regression',
          unbounded: 'must not be returned',
        },
      },
    })]);
    const result = response.results[0]!;

    expect([...result.title]).toHaveLength(MAX_SEARCH_TITLE_CODE_POINTS);
    expect(result.tags).toHaveLength(MAX_SEARCH_TAGS);
    expect(result.tags.every(tag => [...tag].length <= MAX_SEARCH_TAG_CODE_POINTS)).toBe(true);
    expect(result.metadata.task).toEqual({
      status: expect.any(String),
      priority: 'high',
      completion_evidence: 'verified by focused regression',
    });
    expect([...(result.metadata.task as { status: string }).status]).toHaveLength(
      MAX_SEARCH_METADATA_STRING_CODE_POINTS,
    );
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(24 * 1024);
  });

  it.each([
    ['title', { title: 'x'.repeat(MAX_SEARCH_TITLE_CODE_POINTS + 1) }],
    ['tag', { tags: ['x'.repeat(MAX_SEARCH_TAG_CODE_POINTS + 1)] }],
    ['task metadata', {
      metadata: { task: { status: 'x'.repeat(MAX_SEARCH_METADATA_STRING_CODE_POINTS + 1) } },
    }],
  ] as Array<[string, Partial<Entry>]>)('marks a bounded %s as truncated', (_field, overrides) => {
    const response = buildBoundedSearchResponse([entry(overrides)]);

    expect(response.returned).toBe(1);
    expect(response.omitted).toBe(0);
    expect(response.truncated).toBe(true);
  });

  it('returns only a ranked prefix when the next bounded hit cannot fit', () => {
    const response = buildBoundedSearchResponse([
      entry({ id: 'FIRST', title: '😀'.repeat(10_000) }),
      entry({ id: 'SECOND', title: 'small' }),
    ], 500, 200);

    expect(response.results).toEqual([]);
    expect(response.returned).toBe(0);
    expect(response.omitted).toBe(2);
  });

  it('clamps a tiny byte budget to the minimum valid response budget', () => {
    const response = buildBoundedSearchResponse([
      entry({ id: 'A', title: 'x' }),
    ], 500, 1);

    expect(response.results.map(result => result.id)).toEqual(['A']);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
      SEARCH_RESPONSE_MIN_BYTES,
    );
  });
});
