import type { Entry } from 'tim-core';

export const DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
export const SEARCH_MAX_TOP_K = 100;
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
  'completion_evidence',
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

/**
 * Oversized `topK` / `excerptChars` are clamped, not rejected. The 24 KiB
 * response budget truncates first, so a caller asking for 2000 excerpt chars
 * was never going to get them — failing the call just returns nothing instead
 * of something. The adjustment is reported back so nobody mistakes a trimmed
 * result set for the full one.
 */
export function clampSearchRequest(
  topK: number,
  excerptChars: number,
): { topK: number; excerptChars: number; clamped?: string[] } {
  const clamped: string[] = [];
  if (topK > SEARCH_MAX_TOP_K) {
    clamped.push(`topK clamped from ${topK} to ${SEARCH_MAX_TOP_K}`);
    topK = SEARCH_MAX_TOP_K;
  }
  if (excerptChars > DEFAULT_SEARCH_EXCERPT_CODE_POINTS) {
    clamped.push(
      `excerptChars clamped from ${excerptChars} to ${DEFAULT_SEARCH_EXCERPT_CODE_POINTS}`,
    );
    excerptChars = DEFAULT_SEARCH_EXCERPT_CODE_POINTS;
  }
  return clamped.length > 0 ? { topK, excerptChars, clamped } : { topK, excerptChars };
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

interface BoundedValue<T> {
  value: T | undefined;
  truncated: boolean;
}

function boundedScalar(
  value: unknown,
): BoundedValue<string | number | boolean | null> {
  if (typeof value === 'string') {
    const bounded = unicodeExcerpt(value, MAX_SEARCH_METADATA_STRING_CODE_POINTS);
    return { value: bounded.excerpt, truncated: bounded.truncated };
  }
  if (typeof value === 'number') {
    return { value: Number.isFinite(value) ? value : undefined, truncated: !Number.isFinite(value) };
  }
  if (typeof value === 'boolean' || value === null) return { value, truncated: false };
  return { value: undefined, truncated: value !== undefined };
}

function boundedTask(value: unknown): BoundedValue<unknown> {
  if (typeof value !== 'object' || value === null) return boundedScalar(value);
  if (Array.isArray(value)) return { value: undefined, truncated: true };

  const task = value as Record<string, unknown>;
  const selected: Record<string, string | number | boolean | null> = {};
  let truncated = false;
  for (const key of SEARCH_TASK_KEYS) {
    const field = boundedScalar(task[key]);
    truncated ||= field.truncated;
    if (field.value !== undefined) selected[key] = field.value;
  }
  return { value: selected, truncated };
}

function selectMetadata(metadata: Record<string, unknown>): BoundedValue<Record<string, unknown>> {
  const selected: Record<string, unknown> = {};
  let truncated = false;
  for (const key of SEARCH_METADATA_KEYS) {
    const value = key === 'task' ? boundedTask(metadata[key]) : boundedScalar(metadata[key]);
    truncated ||= value.truncated;
    if (value.value !== undefined) selected[key] = value.value;
  }
  return { value: selected, truncated };
}

function boundedTags(tags: string[]): BoundedValue<string[]> {
  let truncated = tags.length > MAX_SEARCH_TAGS;
  const value = tags.slice(0, MAX_SEARCH_TAGS).map(tag => {
    const bounded = unicodeExcerpt(tag, MAX_SEARCH_TAG_CODE_POINTS);
    truncated ||= bounded.truncated;
    return bounded.excerpt;
  });
  return { value, truncated };
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
  let resultTruncated = false;

  for (const entry of entries) {
    const excerpt = unicodeExcerpt(entry.content, boundedExcerptCodePoints);
    const title = unicodeExcerpt(entry.title, MAX_SEARCH_TITLE_CODE_POINTS);
    const tags = boundedTags(entry.tags);
    const metadata = selectMetadata(entry.metadata);
    const candidateTruncated =
      excerpt.truncated || title.truncated || tags.truncated || metadata.truncated;
    const candidate: BoundedSearchResult = {
      id: entry.id,
      title: title.excerpt,
      excerpt: excerpt.excerpt,
      tags: tags.value ?? [],
      metadata: metadata.value ?? {},
    };
    const proposed = responseFor(
      [...accepted, candidate],
      entries.length,
      resultTruncated || candidateTruncated,
    );
    if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= effectiveMaxBytes) {
      accepted.push(candidate);
      resultTruncated ||= candidateTruncated;
    } else {
      break;
    }
  }

  return responseFor(accepted, entries.length, resultTruncated);
}
