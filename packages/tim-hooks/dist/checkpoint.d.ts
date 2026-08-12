import type { Entry } from 'tim-core';
import type { HooksConfig } from 'tim-core';
import { type Summarizer, type TimStore } from 'tim-store';
import { type HookEnv } from './hooks.js';
import { type Spawner } from './session-hooks.js';
export interface SessionEndOptions {
    summarize?: Summarizer;
    hooksConfig?: HooksConfig;
    env?: HookEnv;
    /** Test seam for the summarizer spawn; production uses the detached spawner. */
    spawn?: Spawner;
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
/** Checkpoint then spawn summarizer — same ordering as `tim checkpoint` (issue #18). */
export declare function runCheckpointWithSummarizerSpawn(store: TimStore, sessionId: string, cwd: string, opts?: {
    handoffNote?: string;
    spawn?: Spawner;
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
export interface SessionStartPreview {
    projectLabel: string;
    /** Display label the directive would use, e.g. "P0063 — TIM …". */
    binding: string;
    /** Session that fed the session-dependent half; null when the project has none. */
    sessionId: string | null;
    /** The directive text a start hook would emit for this project. */
    directive: string;
    /** What runSessionStart would return as `briefing`; null when there is nothing. */
    briefing: string | null;
}
/**
 * What a session start would *say*, without starting one.
 *
 * runSessionStart above does four writes before it assembles any text — it
 * creates the session, may write a marker, runs configured hooks, and its delta
 * is computed against a session that now exists. This reproduces only the
 * assembly (lines 217-239 there) against a session that is already in the
 * store, so the answer can be inspected without changing the thing being
 * inspected: no session node, no marker, no configured hooks.
 *
 * Reads still touch `accessed_at`, and getUpdateCheckLineBriefing may refresh
 * its own cache — this is "makes no memory changes", not "makes no writes".
 */
export declare function previewSessionStart(store: TimStore, params: {
    projectId: string;
    maxTokens: number;
    /** Defaults to the project's most recent session. */
    sessionId?: string;
    /** Directive flavour: from a .tim-project marker, or from session metadata. */
    origin?: 'marker' | 'session';
    cwd?: string;
}): Promise<SessionStartPreview>;
export declare function runSessionEnd(store: TimStore, sessionId: string, opts?: SessionEndOptions): Promise<Entry>;
/**
 * Harness session-end body: checkpoint a session that actually logged something.
 *
 * A harness ends sessions the agent never closes itself (`/clear`, exit), so this
 * is the only automatic checkpoint. Two guards: an unknown session id is not ours
 * to summarize, and a session with no exchanges would only grow the empty summary
 * nodes we already fixed elsewhere. The payload's cwd is a hint — the session node
 * records the directory it started in, so the checkpoint works without it.
 */
export declare function runHarnessSessionEnd(store: TimStore, payload: {
    session_id?: unknown;
    cwd?: unknown;
}, opts?: SessionEndOptions): Promise<Entry | null>;
//# sourceMappingURL=checkpoint.d.ts.map