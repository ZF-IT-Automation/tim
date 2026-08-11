import type { UnsummarizedBatch } from './mcp-client.js';
export type ErrorLogFn = (tool: string, error: string, stack?: string) => void;
/** Compact thematic summary for a batch (no external API required). */
export declare function generateSummaryHeuristic(batch: UnsummarizedBatch): string;
export declare function buildPrompt(batch: UnsummarizedBatch): string;
export declare const FALLBACK_MARKER = "TIM_SUMMARIZER_FALLBACK_NEEDED";
/**
 * How a summary was produced. Anything other than 'ok' means the stored text is
 * degraded (marker or raw transcript), not a real summary.
 */
export type SummaryStatus = 'ok' | 'no-chain' | 'heuristic';
export interface SummaryResult {
    text: string;
    status: SummaryStatus;
}
/** Actionable operator message — a missing chain is config, not a transient CLI failure. */
export declare function noChainHint(): string;
/** Parse TAGS line from LLM output; strip it from body. */
export declare function extractTags(text: string): {
    body: string;
    tags: string[];
};
export declare function tryCli(cli: string, model: string, provider: string | undefined, prompt: string, timeoutSec: number, onError?: ErrorLogFn, extraArgs?: string[]): Promise<string | null>;
/**
 * Condense one session's batch summaries into a next-session handoff via the CLI chain.
 * Returns null on total failure (no chain, no input, or every CLI failed) so the caller
 * can fall back to plain concatenation instead of storing a degraded blob.
 */
export declare function generateSessionRollup(batchSummaries: string[], onError?: ErrorLogFn): Promise<string | null>;
/**
 * Aggregate session summaries into a project-level summary via the CLI chain.
 * Returns null on total failure (no chain, no input, or every CLI failed) —
 * caller must then write NOTHING, never a fallback marker into project content.
 */
export declare function generateProjectSummary(sessionSummaries: string[], onError?: ErrorLogFn): Promise<string | null>;
/**
 * Summarize a batch and report *how* it was produced, so a caller can tell a real
 * summary apart from the marker / heuristic transcript that both get stored verbatim.
 */
export declare function generateSummaryDetailed(batch: UnsummarizedBatch, onError?: ErrorLogFn): Promise<SummaryResult>;
export declare function generateSummary(batch: UnsummarizedBatch, onError?: ErrorLogFn): Promise<string>;
//# sourceMappingURL=generate-summary.d.ts.map