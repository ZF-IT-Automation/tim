import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export type ExchangeRole = 'user' | 'agent';
export interface Exchange {
    role: ExchangeRole;
    content: string;
}
export type Summarizer = (exchanges: Entry[]) => Promise<string>;
export interface BatchFullInfo {
    sessionId: string;
    batchId: string;
    batchIndex: number;
}
export type OnBatchFullHandler = (info: BatchFullInfo) => void;
export interface SessionStartParams {
    sessionId: string;
    agentName: string;
    cwd: string;
    harness: string;
}
/**
 * A session node is keyed by its id, so a blank one produces an unaddressable
 * node that no turn-end hook can ever find again — the database already holds
 * one written with the empty string. Callers pass a harness session id or an
 * id of their own; either way it has to be usable as a key.
 */
export declare function assertSessionId(sessionId: string): void;
export interface ProjectSessionParams extends SessionStartParams {
    projectId: string;
    batchSize?: number;
    summarizer?: {
        cli: string;
        model: string;
    };
    tool?: string;
    model?: string;
    taskSummary?: string;
}
export interface UnsummarizedExchange {
    seq: number;
    userId: string;
    userContent: string;
    agentId: string | null;
    agentContent: string | null;
}
export interface UnsummarizedBatch {
    sessionId: string;
    summaryNodeId: string;
    exchangesNodeId: string;
    batchIndex: number;
    batchSize: number;
    exchanges: UnsummarizedExchange[];
    hasMore: boolean;
    previousSummaries: string[];
    sessionMeta: {
        project?: string;
        tool?: string;
        model?: string;
        task_summary?: string;
    };
    /**
     * The project's existing content tags, most frequent first, for the prompt to
     * reuse. Absent when the session has no project or the lookup failed — the
     * prompt then falls back to its old wording rather than blocking the summary.
     */
    vocabulary?: string[];
}
export interface ResumeBatchSummary {
    batchIndex: number;
    seqFrom: number;
    seqTo: number;
    text: string;
}
export interface ResumeExchange {
    seq: number;
    userContent: string;
    agentContent: string | null;
}
export interface ResumePayload {
    sessionId: string;
    sessionMeta: {
        project?: string;
        date?: string;
        tool?: string;
        toolHistory: string[];
        exchangeCount: number;
        taskSummary?: string;
    };
    sessionSummary: string;
    handoffNote?: string;
    batchSummaries: ResumeBatchSummary[];
    recentExchanges: ResumeExchange[];
    warnings: string[];
}
export interface ResumeSessionOpts {
    newHarnessId?: string;
    tool?: string;
    model?: string;
    rawCount?: number;
    /** When set, reject resume if the session belongs to a different project. */
    boundProjectId?: string;
}
export interface ResumableSession {
    sessionId: string;
    title: string;
    date?: string;
    lastActivity: string;
    tool?: string;
    taskSummary?: string;
    exchangeCount: number;
    summaryFirstLine: string;
}
export interface UntaggedBatch {
    sessionId: string;
    batchNodeId: string;
    batchIndex: number;
    title: string;
    seqFrom: number;
    seqTo: number;
}
/**
 * Exchanges are stored through splitTitleBody, so the first line of the message
 * lives in the title and only the remainder in the content. Reading the content
 * alone silently drops that first line — for an agent answer that is its lead.
 */
export declare function exchangeText(entry: Entry): string;
export declare class SessionManager {
    private store;
    private onBatchFull?;
    constructor(store: TimStore);
    /** Live summarizer trigger when an exchange-batch fills (wired from tim-mcp). */
    setOnBatchFull(handler: OnBatchFullHandler | undefined): void;
    sessionStart(params: SessionStartParams): Promise<Entry>;
    startProjectSession(params: ProjectSessionParams): Promise<Entry>;
    sessionLog(sessionId: string, entries: Exchange[]): Promise<Entry[]>;
    /**
     * Synchronous body of logExchange for use inside `store.runExclusive`.
     * Caller must already hold the exclusive lock and have validated the session.
     */
    private logExchangeSync;
    logExchange(sessionId: string, entries: Exchange[]): Promise<Entry[]>;
    /**
     * Log an exchange at most once for the given deterministic exchange key.
     * Duplicate check and writes share one exclusive transaction.
     */
    logExchangeOnce(sessionId: string, exchangeKey: string, entries: Exchange[]): Promise<Entry[]>;
    showUnsummarized(sessionId: string): Promise<UnsummarizedBatch>;
    writeBatchSummary(sessionId: string, batchIndex: number, summaryText: string, range: {
        seqFrom: number;
        seqTo: number;
    }, tags?: string[]): Promise<Entry>;
    private writeBatchSummarySync;
    private syncSessionBatchesSummarized;
    /**
     * Recompute session-level content tags from batch summaries.
     *
     * The frequency bar depends on how many batches there are: with one or two,
     * every content tag qualifies — a short session has no topic drift to filter
     * out, only tags to lose, and a single-batch session could never clear a
     * two-batch bar at all. From three batches on the old `>= 2` rule returns: a
     * Summary root carrying twelve tags matches every topic and sharpens none.
     */
    aggregateSessionTags(sessionId: string): Promise<Entry | null>;
    /** Batch summary nodes with no content tags (only structural tags). */
    showUntagged(): Promise<UntaggedBatch[]>;
    rollUpSession(sessionId: string, fold: (batches: Entry[]) => Promise<string>): Promise<Entry>;
    getSessionExchanges(sessionId: string): Promise<Entry[]>;
    /** Scan all project sessions and return their unsummarized batches (cleanup sweep). */
    showAllUnsummarized(): Promise<UnsummarizedBatch[]>;
    checkpoint(sessionId: string, opts?: {
        summarize?: Summarizer;
        runDecay?: boolean;
        handoffNote?: string;
    }): Promise<Entry>;
    /** Upsert session-summary-root content after checkpoint / rollup. */
    updateSessionSummary(sessionId: string, summaryText: string): Promise<Entry>;
    resumeSession(oldSessionId: string, opts?: ResumeSessionOpts): Promise<ResumePayload>;
    /**
     * Delete checkpoint nodes whose session rollup already exists on the Summary root.
     * Sweep all sessions when sessionId omitted. Returns count deleted.
     */
    reapCoveredCheckpoints(sessionId?: string): Promise<number>;
    listResumableSessions(projectRef: string, limit?: number): Promise<ResumableSession[]>;
    private static readonly PROJECT_STATS_MARKER;
    /** Refresh project-root stats line (entry count + last activity). */
    updateProjectSummary(projectId: string): Promise<Entry>;
}
export interface EnsureProjectForPathResult {
    label: string;
    entry: Entry;
    created: boolean;
}
/**
 * Auto-create a project from a directory name when no .tim-project binding exists.
 * Re-bind to an existing project with the same directory alias. Reversible via
 * irrelevant flag on the project root.
 */
/** Latest kind=session entry for a project whose metadata.cwd matches. */
export declare function resolveCurrentSession(store: TimStore, projectLabel: string, cwd?: string): Promise<Entry | null>;
export declare function ensureProjectForPath(store: TimStore, cwd: string): Promise<EnsureProjectForPathResult | null>;
//# sourceMappingURL=session.d.ts.map