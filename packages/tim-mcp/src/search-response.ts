import type { Entry } from 'tim-core';

export const DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
export const SEARCH_RESPONSE_MAX_BYTES = 24 * 1024;

const SEARCH_METADATA_KEYS = [
  'kind',
  'label',
  'type',
  'status',
  'project_ref',
  'task',
] as const;

export interface BoundedSearchResult {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface BoundedSearchResponse {
  results: BoundedSearchResult[];
  returned: number;
  omitted: number;
  truncated: boolean;
}

function unicodeExcerpt(
  text: string,
  maxCodePoints: number,
): { excerpt: string; truncated: boolean } {
  if (maxCodePoints <= 0) return { excerpt: '', truncated: text.length > 0 };
  const points = Array.from(text);
  if (points.length <= maxCodePoints) return { excerpt: text, truncated: false };
  if (maxCodePoints === 1) return { excerpt: '…', truncated: true };
  return {
    excerpt: `${points.slice(0, maxCodePoints - 1).join('')}…`,
    truncated: true,
  };
}

function selectMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of SEARCH_METADATA_KEYS) {
    if (metadata[key] !== undefined) selected[key] = metadata[key];
  }
  return selected;
}

function responseFor(
  results: BoundedSearchResult[],
  total: number,
  excerptTruncated: boolean,
): BoundedSearchResponse {
  const omitted = total - results.length;
  return {
    results,
    returned: results.length,
    omitted,
    truncated: omitted > 0 || excerptTruncated,
  };
}

export function buildBoundedSearchResponse(
  entries: Entry[],
  excerptCodePoints = DEFAULT_SEARCH_EXCERPT_CODE_POINTS,
  maxBytes = SEARCH_RESPONSE_MAX_BYTES,
): BoundedSearchResponse {
  const accepted: BoundedSearchResult[] = [];
  const boundedExcerptCodePoints = Math.min(
    Math.max(0, excerptCodePoints),
    DEFAULT_SEARCH_EXCERPT_CODE_POINTS,
  );
  let excerptTruncated = false;

  for (const entry of entries) {
    const excerpt = unicodeExcerpt(entry.content, boundedExcerptCodePoints);
    const candidate: BoundedSearchResult = {
      id: entry.id,
      title: entry.title,
      excerpt: excerpt.excerpt,
      tags: entry.tags,
      metadata: selectMetadata(entry.metadata),
    };
    const proposed = responseFor(
      [...accepted, candidate],
      entries.length,
      excerptTruncated || excerpt.truncated,
    );
    if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= maxBytes) {
      accepted.push(candidate);
      excerptTruncated ||= excerpt.truncated;
    }
  }

  return responseFor(accepted, entries.length, excerptTruncated);
}
