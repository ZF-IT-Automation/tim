import type { TimStore, SearchSemanticInfo } from 'tim-store';
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
  asOf?: string;
}

export interface TimSearchToolResult {
  response: Record<string, unknown>;
  results: Entry[];
  semantic: SearchSemanticInfo | null;
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

  let results: Entry[];
  let semantic: SearchSemanticInfo | null = null;

  if (query === undefined) {
    results = await store.searchByTag(tag!, topK, root, { type, status });
  } else {
    const searchResult = await store.searchWithSemantics({
      query,
      topK,
      searchType,
      project: root,
      type,
      tag,
      status,
      asOf: parsed.asOf,
    });
    results = searchResult.entries;
    semantic = searchResult.semantic;
  }

  const response = {
    ...buildBoundedSearchResponse(results, excerptChars),
    ...(clamped ? { clamped } : {}),
    ...(semantic ? { semantic } : {}),
  };

  return { response, results, semantic };
}
