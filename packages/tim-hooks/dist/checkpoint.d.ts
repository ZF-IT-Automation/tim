import type { Entry } from 'tim-core';
import type { HooksConfig } from 'tim-core';
import { type Summarizer, type TimStore } from 'tim-store';
import { type HookEnv } from './hooks.js';
export interface SessionEndOptions {
    summarize?: Summarizer;
    hooksConfig?: HooksConfig;
    env?: HookEnv;
}
export interface SessionStartResult {
    session: Entry;
    project: Entry | null;
    /** Optional briefing supplement (delta, update check, …). */
    briefing?: string;
}
/** Resolve active project label from TIM_PROJECT env or ~/.tim/active-project. */
export declare function getActiveProjectLabel(): string | null;
/**
 * Resolve the active project from a .tim-project marker in cwd ONLY.
 *
 * No walk-up. No parent traversal. This is the Auto-Load Hook contract:
 * a session binds to a project only if the marker is in the directory the
 * user explicitly invoked the harness from. Walking up to a parent has
 * caused repeated cross-project binding bugs (Worker A→B→C in 2 days);
 * cwd-only is the same pattern Hermes statusline uses after the 133c5abd
 * fix in its-over-9k, kept consistent here.
 *
 * Falls back to:
 *  - readMarker(cwd) which checks .tim-project and then tim.json
 *  - validateMarkerAgainstStore which gates the project label against the DB
 *
 * Returns the project label, or null when no cwd marker exists, the marker
 * is corrupt, or the project does not exist in the DB.
 */
export declare function resolveActiveProjectFromCwd(cwd: string, store: TimStore): Promise<string | null>;
/** Load project entry by hmem-style label (e.g. P0062) when configured. */
export declare function loadProjectContext(store: TimStore): Promise<Entry | null>;
export declare function runCheckpoint(store: TimStore, sessionId: string, opts?: {
    summarize?: Summarizer;
    runDecay?: boolean;
    handoffNote?: string;
}): Promise<Entry>;
export declare function runSessionStart(store: TimStore, params: {
    sessionId: string;
    agentName: string;
    cwd: string;
    harness: string;
    hooksConfig?: HooksConfig;
    projectId?: string;
    batchSize?: number;
    tool?: string;
    model?: string;
    taskSummary?: string;
}): Promise<SessionStartResult>;
export declare function runSessionEnd(store: TimStore, sessionId: string, opts?: SessionEndOptions): Promise<Entry>;
//# sourceMappingURL=checkpoint.d.ts.map