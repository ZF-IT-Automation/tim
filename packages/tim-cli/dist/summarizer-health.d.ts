import { type TimConfigFile } from 'tim-core';
import { TimStore } from 'tim-store';
export interface SummarizerHealth {
    healthy: boolean;
    /** First chain entry, formatted as cli/model — null when no chain is configured. */
    firstEntry: string | null;
    chainLength: number;
    /** Session ids whose stored summary still carries the failure marker. */
    corruptedSessions: string[];
    issues: string[];
}
/** PATH lookup without spawning anything — doctor stays read-only. */
export declare function resolveOnPath(command: string): boolean;
/** Read-only summarizer health check for `tim doctor` (no writes, no spawns). */
export declare function auditSummarizerHealth(store: TimStore, config: TimConfigFile): Promise<SummarizerHealth>;
//# sourceMappingURL=summarizer-health.d.ts.map