import { type TimStore } from 'tim-store';
import type { DirectiveBriefing } from './marker.js';
/**
 * Clamp a summary to a char budget without losing its end. The last lines of a
 * condensed rollup are the handoff ("next: …") — cutting from the front would drop
 * exactly what the new session needs.
 */
export declare function clampSummary(text: string, maxChars: number): string;
/**
 * The turns no batch summary covers, newest last. Every session has such a tail —
 * a batch is only summarized once it is full — and for the last few turns the raw
 * text beats a summary: it is what happened, not a retelling.
 *
 * Deliberately not `showUnsummarized`: that one returns the *oldest* uncovered
 * batch (correct for the summarizer, which works forward), which here would render
 * the opening of a never-summarized session under a "since the last summary" heading.
 */
export declare function recentExchanges(store: TimStore, sessionId: string, maxChars: number): Promise<string[]>;
/**
 * Build the directive briefing for a project. Returns undefined when there is
 * nothing to inject, so the directive falls back to its instruction-only form.
 *
 * `includePastWork` decides whether the previous session comes along. It is a
 * call parameter with one hard-coded value per caller, not a setting: the two
 * automatic callers in tim-cli pass `false`, so a fresh session starts with
 * structure and open work only, and `previewSessionStart` passes `true`, which
 * is what `/tim-continue` renders on demand. Past work is retrieved by topic
 * now (`tim_resume_topic`), not injected by recency into every session that
 * happens to start in this directory.
 */
export declare function collectDirectiveBriefing(store: TimStore, projectLabel: string, maxTokens: number, includePastWork: boolean): Promise<DirectiveBriefing | undefined>;
//# sourceMappingURL=session-briefing.d.ts.map