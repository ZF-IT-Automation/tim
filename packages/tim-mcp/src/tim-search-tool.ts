import type { TimStore, SearchSemanticInfo } from 'tim-store';
import type { Entry } from 'tim-core';
import { resolveSearchAsOf } from 'tim-store';
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
  includeCommits?: boolean;
}

export interface TimSearchToolResult {
  response: Record<string, unknown>;
  results: Entry[];
  semantic: SearchSemanticInfo | null;
}

/**
 * Plain FTS does not consult the embedding provider. `requestedMode: fts` plus
 * `providerState: not_used` and no degradation flags is the default payload —
 * the configured model id on that path did not participate. Vector, hybrid,
 * and any fallback stay on the response.
 */
export function semanticForAgent(
  semantic: SearchSemanticInfo | null,
): SearchSemanticInfo | undefined {
  if (!semantic) return undefined;
  if (
    semantic.requestedMode === 'fts'
    && semantic.providerState === 'not_used'
    && semantic.degradedToLexical !== true
    && semantic.vectorUnavailable !== true
  ) {
    return undefined;
  }
  return semantic;
}

/**
 * Shared tim_search execution path for MCP server and in-process tests (#33).
 */
export async function executeTimSearch(
  store: TimStore,
  parsed: TimSearchToolArgs,
): Promise<TimSearchToolResult> {
  const { query, root, type, tag, status, searchType, includeCommits } = parsed;
  const { topK, excerptChars, clamped } =
    clampSearchRequest(parsed.topK ?? 10, parsed.excerptChars ?? 500);

  let results: Entry[];
  let semantic: SearchSemanticInfo | null = null;

  if (query === undefined) {
    if (parsed.asOf !== undefined) {
      resolveSearchAsOf(parsed.asOf);
    }
    results = await store.searchByTag(tag!, topK, root, { type, status, asOf: parsed.asOf });
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
      includeCommits,
    });
    results = searchResult.entries;
    semantic = searchResult.semantic;
  }

  const agentSemantic = semanticForAgent(semantic);
  const response = {
    ...buildBoundedSearchResponse(results, excerptChars),
    ...(clamped ? { clamped } : {}),
    ...(agentSemantic ? { semantic: agentSemantic } : {}),
  };

  return { response, results, semantic };
}
