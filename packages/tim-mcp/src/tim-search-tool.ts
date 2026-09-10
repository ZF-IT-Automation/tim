import type { TimStore } from 'tim-store';
import type { Entry } from 'tim-core';
import { buildBoundedSearchResponse, clampSearchRequest } from './search-response.js';

export interface TimSearchToolArgs {
  query?: string;
  topK?: number;
  excerptChars?: number;
  searchType?: 'fts' | 'vector' | 'hybrid';
  root?: string;
  type?: string;
  tag?: string;
  status?: string;
}

export interface TimSearchToolResult {
  response: Record<string, unknown>;
  results: Entry[];
}

/**
 * Shared tim_search execution path for MCP server and in-process tests (#33).
 */
export async function executeTimSearch(
  store: TimStore,
  parsed: TimSearchToolArgs,
): Promise<TimSearchToolResult> {
  const { query, root, type, tag, status, searchType } = parsed;
  const { topK, excerptChars, clamped } =
    clampSearchRequest(parsed.topK ?? 10, parsed.excerptChars ?? 500);

  let results = query === undefined
    ? await store.searchByTag(tag!, topK, root, { type, status })
    : await store.search({
        query,
        topK,
        searchType,
        project: root,
        type,
        tag,
        status,
      });

  const response = {
    ...buildBoundedSearchResponse(results, excerptChars),
    ...(clamped ? { clamped } : {}),
    ...(store.lastSearchSemantic ? { semantic: store.lastSearchSemantic } : {}),
  };

  return { response, results };
}
