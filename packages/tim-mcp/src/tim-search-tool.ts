import type { TimStore } from 'tim-store';
import type { Entry } from 'tim-core';
import { resolveSearchAsOf } from 'tim-store';
import { buildBoundedSearchResponse, clampSearchRequest } from './search-response.js';

export interface TimSearchToolArgs {
  query?: string;
  topK?: number;
  excerptChars?: number;
  /** Accepted for compatibility. Every value is full-text search. */
  searchType?: string;
  root?: string;
  type?: string;
  tag?: string;
  status?: string;
  asOf?: string;
  includeCommits?: boolean;
}

export interface TimSearchToolResult {
  response: Record<string, unknown>;
  results: Entry[];
}

/**
 * Shared tim_search execution path for MCP server and in-process tests.
 */
export async function executeTimSearch(
  store: TimStore,
  parsed: TimSearchToolArgs,
): Promise<TimSearchToolResult> {
  const { query, root, type, tag, status, includeCommits } = parsed;
  const { topK, excerptChars, clamped } =
    clampSearchRequest(parsed.topK ?? 10, parsed.excerptChars ?? 500);

  let results: Entry[];

  if (query === undefined) {
    if (parsed.asOf !== undefined) {
      resolveSearchAsOf(parsed.asOf);
    }
    results = await store.searchByTag(tag!, topK, root, { type, status, asOf: parsed.asOf });
  } else {
    results = await store.search({
      query,
      topK,
      project: root,
      type,
      tag,
      status,
      asOf: parsed.asOf,
      includeCommits,
    });
  }

  const response = {
    ...buildBoundedSearchResponse(results, excerptChars),
    ...(clamped ? { clamped } : {}),
  };

  return { response, results };
}
