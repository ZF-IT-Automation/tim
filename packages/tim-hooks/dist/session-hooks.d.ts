import type { TimStore } from 'tim-store';
export interface SpawnContext {
    sessionId: string;
    cwd: string;
}
export type Spawner = (command: string, ctx: SpawnContext) => void;
export type SessionStopReason = 'spawned' | 'no-marker' | 'below-threshold' | 'locked' | 'spawn-failed';
export interface SessionStopResult {
    spawned: boolean;
    reason: SessionStopReason;
    pending?: number;
}
export { DEFAULT_SUMMARIZER_TIMEOUT_SEC } from './constants.js';
export declare function summarizerLogPath(cwd: string): string;
/** Shell snippet: trap lock release, timeout, run tim-summarizer CLI with log append. */
export declare function buildSummarizerCommand(sessionId: string, lockPath: string, logPath: string, timeoutSec?: number): string;
/** Detached spawn with log dir creation and spawn-error capture (does not throw). */
export declare const spawnSummarizer: Spawner;
/** @deprecated Use spawnSummarizer */
export declare const detachedSpawner: Spawner;
export interface MaybeSpawnSummarizerOptions {
    spawn?: Spawner;
    /** Skip pending threshold — use when a batch just filled (live trigger). */
    batchFull?: boolean;
    timeoutSec?: number;
}
/** Shared spawn gate for session-stop hook and live batch-full trigger. */
export declare function maybeSpawnSummarizer(store: TimStore, cwd: string, opts?: MaybeSpawnSummarizerOptions): Promise<SessionStopResult>;
export declare function onSessionStop(store: TimStore, cwd: string, opts?: {
    spawn?: Spawner;
    timeoutSec?: number;
}): Promise<SessionStopResult>;
export declare const DEFAULT_PROJECT_SUMMARY_THRESHOLD = 5;
/** Shell snippet: run tim-summarizer in --project-summary mode for a label. */
export declare function buildProjectSummaryCommand(label: string, logPath: string, timeoutSec?: number): string;
export type ProjectSummaryReason = 'spawned' | 'no-label' | 'no-sessions' | 'below-threshold' | 'spawn-failed';
export interface ProjectSummaryResult {
    spawned: boolean;
    reason: ProjectSummaryReason;
    count?: number;
}
export interface MaybeSpawnProjectSummaryOptions {
    spawn?: Spawner;
    threshold?: number;
    timeoutSec?: number;
}
/**
 * Gate + detached spawn for periodic project-summary generation.
 * Fires only when sessions-so-far is a positive multiple of the threshold.
 * Fire-and-forget — never throws.
 */
export declare function maybeSpawnProjectSummary(store: TimStore, cwd: string, label: string | null, opts?: MaybeSpawnProjectSummaryOptions): Promise<ProjectSummaryResult>;
//# sourceMappingURL=session-hooks.d.ts.map