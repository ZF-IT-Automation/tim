#!/usr/bin/env node
import { TimStore } from 'tim-store';
export declare const PROJECT_SUMMARY_MARKER = "## Project Summary";
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
export declare function runSummarizerLoop(sessionId: string): Promise<number>;
//# sourceMappingURL=summarize.d.ts.map