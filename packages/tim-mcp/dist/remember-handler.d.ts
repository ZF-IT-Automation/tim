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
    parents: Array<{
        id: string;
        title: string;
    }>;
    reasoning?: string;
}
export type RememberFallbackUsed = 'none' | 'timeout' | 'error' | 'empty_query' | 'no_fts_hits' | 'all_chain_failed' | 'invalid_json';
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
    parents: Array<{
        id: string;
        title: string;
    }>;
}
export interface RankedCandidate {
    node_id: string;
    confidence: number;
    reasoning: string;
}
export type RerankFallback = 'none' | 'timeout' | 'error' | 'all_chain_failed' | 'invalid_json';
export interface RerankResult {
    ranked: RankedCandidate[] | null;
    model: string;
    tokensIn: number;
    tokensOut: number;
    fallback: RerankFallback;
}
export interface RememberQueryInput {
    query: string;
    candidates: RememberCandidate[];
    batchSummaries?: Array<{
        id: string;
        title: string;
        excerpt: string;
    }>;
    topK: number;
}
export declare function appendRememberLog(line: string): void;
export declare function getProjectParent(store: TimStore, entryId: string): Promise<Array<{
    id: string;
    title: string;
}>>;
declare function spawnRememberSubprocessImpl(input: RememberQueryInput, hardTimeoutMs: number): Promise<RerankResult>;
/** Injectable subprocess spawn — tests replace this without patching ESM internals. */
export declare const rememberDeps: {
    spawnRememberSubprocess: typeof spawnRememberSubprocessImpl;
};
export { spawnRememberSubprocessImpl as spawnRememberSubprocess };
export declare function handleTimRemember(store: TimStore, opts: TimRememberOptions): Promise<TimRememberResult>;
//# sourceMappingURL=remember-handler.d.ts.map