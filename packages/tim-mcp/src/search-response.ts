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

function unicodeExcerpt(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  const points = Array.from(text);
  if (points.length <= maxCodePoints) return text;
  if (maxCodePoints === 1) return '…';
  return `${points.slice(0, maxCodePoints - 1).join('')}…`;
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
): BoundedSearchResponse {
  const omitted = total - results.length;
  return {
    results,
    returned: results.length,
    omitted,
    truncated: omitted > 0,
  };
}

export function buildBoundedSearchResponse(
  entries: Entry[],
  excerptCodePoints = DEFAULT_SEARCH_EXCERPT_CODE_POINTS,
  maxBytes = SEARCH_RESPONSE_MAX_BYTES,
): BoundedSearchResponse {
  const accepted: BoundedSearchResult[] = [];

  for (const entry of entries) {
    const candidate: BoundedSearchResult = {
      id: entry.id,
      title: entry.title,
      excerpt: unicodeExcerpt(entry.content, excerptCodePoints),
      tags: entry.tags,
      metadata: selectMetadata(entry.metadata),
    };
    const proposed = responseFor([...accepted, candidate], entries.length);
    if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= maxBytes) {
      accepted.push(candidate);
    }
  }

  return responseFor(accepted, entries.length);
}
