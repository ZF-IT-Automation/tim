import type { TimStore } from 'tim-store';

export interface TimRememberOptions {
  query: string;
  topK: number;
  minConfidence: number;
  includeBatchSummaries: boolean;
  searchType: 'fts';
  projectScope?: string;
}

export interface TimRememberResultItem {
  node_id: string;
  title: string;
  relevance: number;
  excerpt: string;
  parents: Array<{ id: string; title: string }>;
  reasoning?: string;
}

export type RememberFallbackUsed =
  | 'none'
  | 'timeout'
  | 'error'
  | 'empty_query'
  | 'no_fts_hits'
  | 'all_chain_failed'
  | 'invalid_json';

export interface TimRememberResult {
  query: string;
  results: TimRememberResultItem[];
  meta: {
    latency_ms: number;
    candidates_fts: number;
    candidates_after_rerank: number;
    dropped_hallucinated: number;
    sub_process_model: string;
    sub_process_tokens_in: number;
    sub_process_tokens_out: number;
    fallback_used: RememberFallbackUsed;
  };
}

export interface RememberCandidate {
  id: string;
  title: string;
  excerpt: string;
  parents: Array<{ id: string; title: string }>;
}

export interface RankedCandidate {
  node_id: string;
  confidence: number;
  reasoning: string;
}

export type RerankFallback =
  | 'none'
  | 'timeout'
  | 'error'
  | 'all_chain_failed'
  | 'invalid_json';

export interface RerankResult {
  ranked: RankedCandidate[] | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  fallback: RerankFallback;
}

export interface BatchSummary {
  id: string;
  title: string;
  content: string;
}

export async function handleTimRemember(
  _store: TimStore,
  _opts: TimRememberOptions,
): Promise<TimRememberResult> {
  throw new Error('not implemented — implementation comes in later tasks');
}
