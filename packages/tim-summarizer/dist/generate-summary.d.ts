import type { UnsummarizedBatch } from './mcp-client.js';
export type ErrorLogFn = (tool: string, error: string, stack?: string) => void;
/** Compact thematic summary for a batch (no external API required). */
export declare function generateSummaryHeuristic(batch: UnsummarizedBatch): string;
export declare const FALLBACK_MARKER = "TIM_SUMMARIZER_FALLBACK_NEEDED";
/** Parse TAGS line from LLM output; strip it from body. */
export declare function extractTags(text: string): {
    body: string;
    tags: string[];
};
export declare function tryCli(cli: string, model: string, provider: string | undefined, prompt: string, timeoutSec: number, onError?: ErrorLogFn): Promise<string | null>;
/**
 * Aggregate session summaries into a project-level summary via the CLI chain.
 * Returns null on total failure (no chain, no input, or every CLI failed) —
 * caller must then write NOTHING, never a fallback marker into project content.
 */
export declare function generateProjectSummary(sessionSummaries: string[], onError?: ErrorLogFn): Promise<string | null>;
export declare function generateSummary(batch: UnsummarizedBatch, onError?: ErrorLogFn): Promise<string>;
//# sourceMappingURL=generate-summary.d.ts.map