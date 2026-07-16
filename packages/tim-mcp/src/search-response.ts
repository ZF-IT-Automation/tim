import type { Entry } from 'tim-core';

export const DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
export const SEARCH_RESPONSE_MAX_BYTES = 24 * 1024;
export const SEARCH_RESPONSE_MIN_BYTES = 128;
export const MAX_SEARCH_TITLE_CODE_POINTS = 256;
export const MAX_SEARCH_TAGS = 16;
export const MAX_SEARCH_TAG_CODE_POINTS = 64;

const MAX_SEARCH_METADATA_STRING_CODE_POINTS = 128;
const SEARCH_TASK_KEYS = [
  'status',
  'priority',
  'due',
  'due_date',
  'assignee',
  'order',
] as const;

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
  const points: string[] = [];
  for (const point of text) {
    if (points.length === maxCodePoints) {
      points[points.length - 1] = '…';
      return { excerpt: points.join(''), truncated: true };
    }
    points.push(point);
  }
  return { excerpt: points.join(''), truncated: false };
}

function boundedScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') {
    return unicodeExcerpt(value, MAX_SEARCH_METADATA_STRING_CODE_POINTS).excerpt;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function boundedTask(value: unknown): unknown {
  const scalar = boundedScalar(value);
  if (scalar !== undefined) return scalar;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const task = value as Record<string, unknown>;
  const selected: Record<string, string | number | boolean | null> = {};
  for (const key of SEARCH_TASK_KEYS) {
    const field = boundedScalar(task[key]);
    if (field !== undefined) selected[key] = field;
  }
  return selected;
}

function selectMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of SEARCH_METADATA_KEYS) {
    const value = key === 'task' ? boundedTask(metadata[key]) : boundedScalar(metadata[key]);
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function boundedTags(tags: string[]): string[] {
  return tags.slice(0, MAX_SEARCH_TAGS).map(
    tag => unicodeExcerpt(tag, MAX_SEARCH_TAG_CODE_POINTS).excerpt,
  );
}

function boundedMaxBytes(maxBytes: number): number {
  if (!Number.isFinite(maxBytes)) return SEARCH_RESPONSE_MAX_BYTES;
  return Math.min(
    SEARCH_RESPONSE_MAX_BYTES,
    Math.max(SEARCH_RESPONSE_MIN_BYTES, Math.floor(maxBytes)),
  );
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
  const effectiveMaxBytes = boundedMaxBytes(maxBytes);
  let excerptTruncated = false;

  for (const entry of entries) {
    const excerpt = unicodeExcerpt(entry.content, boundedExcerptCodePoints);
    const candidate: BoundedSearchResult = {
      id: entry.id,
      title: unicodeExcerpt(entry.title, MAX_SEARCH_TITLE_CODE_POINTS).excerpt,
      excerpt: excerpt.excerpt,
      tags: boundedTags(entry.tags),
      metadata: selectMetadata(entry.metadata),
    };
    const proposed = responseFor(
      [...accepted, candidate],
      entries.length,
      excerptTruncated || excerpt.truncated,
    );
    if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= effectiveMaxBytes) {
      accepted.push(candidate);
      excerptTruncated ||= excerpt.truncated;
    } else {
      break;
    }
  }

  return responseFor(accepted, entries.length, excerptTruncated);
}
