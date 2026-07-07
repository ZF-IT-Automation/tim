import type { TimStore } from 'tim-store';
/**
 * Guidance block prepended when tim_session_start fell back to the Inbox
 * (no projectId argument, no active project binding). Lists the most
 * recently active projects so the agent can bind explicitly instead of
 * silently logging exchanges into P0000. Response-driven guidance: weak
 * models follow tool-response text more reliably than system prompts.
 */
export declare function buildInboxFallbackGuidance(store: TimStore): Promise<string | null>;
//# sourceMappingURL=session-guidance.d.ts.map