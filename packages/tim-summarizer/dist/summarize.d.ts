#!/usr/bin/env node
import { TimStore } from 'tim-store';
import { type SummaryStatus } from './generate-summary.js';
export declare const PROJECT_SUMMARY_MARKER = "## Project Summary";
/**
 * Prefix of the placeholder stored when no CLI produced a summary. `tim doctor`
 * scans stored summaries for it to surface previously-corrupted sessions.
 */
export declare const SUMMARY_FAILURE_MARKER = "[ALL SUMMARIZER CLIs FAILED";
/**
 * Idempotently merge a project summary into the project content body.
 * Strips any existing `## Project Summary` block first, so running it twice
 * yields exactly one block — matching the renderer's first-occurrence parse.
 */
export declare function mergeProjectSummary(content: string, summary: string): string;
/**
 * Generate a project-level summary from all session summaries and write it
 * into project.content under `## Project Summary`. Returns true when written,
 * false when skipped (no sessions, or every CLI failed → leave content as-is).
 */
export declare function runProjectSummary(label: string): Promise<boolean>;
/** Process pending curation-queue entries via LLM (duplicates merge, decay confirm). */
export declare function processCurationQueue(store: TimStore, projectLabel: string): Promise<number>;
export interface SummarizerLoopOpts {
    /** Called per batch that was stored degraded (marker or heuristic transcript). */
    onDegraded?: (info: {
        batchIndex: number;
        status: SummaryStatus;
    }) => void;
}
export declare function runSummarizerLoop(sessionId: string, opts?: SummarizerLoopOpts): Promise<number>;
//# sourceMappingURL=summarize.d.ts.map