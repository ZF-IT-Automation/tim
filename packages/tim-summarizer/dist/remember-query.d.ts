export declare const REMEMBER_FALLBACK_MARKER = "TIM_REMEMBER_FALLBACK_NEEDED";
export interface RememberCandidate {
    id: string;
    title: string;
    excerpt: string;
    parents: Array<{
        id: string;
        title: string;
    }>;
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
export interface RankedCandidate {
    node_id: string;
    confidence: number;
    reasoning: string;
}
export interface RerankResult {
    ranked: RankedCandidate[] | null;
    model: string;
    tokensIn: number;
    tokensOut: number;
    fallback: 'none' | 'timeout' | 'error' | 'all_chain_failed' | 'invalid_json';
}
export declare function buildRerankPrompt(input: RememberQueryInput): string;
export declare function parseRerankOutput(text: string, maxTopK: number): RankedCandidate[] | null;
export declare function estimateTokens(text: string): number;
export declare function appendRememberLog(line: string): void;
export declare function rememberRerank(input: RememberQueryInput): Promise<RerankResult>;
//# sourceMappingURL=remember-query.d.ts.map