import { type TimStore } from 'tim-store';
import type { DirectiveBriefing } from './marker.js';
/**
 * Clamp a summary to a char budget without losing its end. The last lines of a
 * condensed rollup are the handoff ("next: …") — cutting from the front would drop
 * exactly what the new session needs.
 */
export declare function clampSummary(text: string, maxChars: number): string;
/**
 * Build the directive briefing for a project. Returns undefined when there is
 * nothing to inject, so the directive falls back to its instruction-only form.
 */
export declare function collectDirectiveBriefing(store: TimStore, projectLabel: string, maxTokens: number): Promise<DirectiveBriefing | undefined>;
//# sourceMappingURL=session-briefing.d.ts.map