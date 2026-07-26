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
    /**
     * Unattended session (cron job, watcher, scheduled agent). Such a session is
     * never "the session the human is in", so `resolveCurrentSession` skips it.
     * Set this from anything that starts a session without a human present.
     */
    automated?: boolean;
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
    /** Recompute session-level content tags from batch summaries (freq >= 2). */
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
 * Unattended session: a cron job, watcher or scheduled agent.
 *
 * `metadata.automated` is the real signal — set it when starting such a
 * session. The id prefix is a fallback for sessions already in the store,
 * which were named `cron_<job>_<timestamp>` by the caller before this flag
 * existed; TIM itself never generated those ids.
 */
export declare function isAutomatedSession(entry: Entry): boolean;
/**
 * Latest kind=session entry for a project, preferring the given cwd.
 *
 * The cwd is a *disambiguator* between concurrent sessions, not a hard filter.
 * Callers routinely pass a directory that is not literally the session's cwd —
 * the statusline, for instance, passes the directory where `.tim-project` was
 * found by walking up, so a session started in a subdirectory would never
 * match on equality alone and every counter read back as zero.
 *
 * Order: exact cwd match, then any session nested under (or containing) that
 * directory, newest first. Unrelated directories still resolve to null so a
 * sibling project's session is never mistaken for this one.
 *
 * Unattended sessions (cron jobs, watchers) are skipped: sorting purely by
 * creation time let a nightly job become "the current session" and report its
 * own empty counters to a human sitting in a live session. Pass
 * `includeAutomated` when the automation is asking about itself.
 */
export declare function resolveCurrentSession(store: TimStore, projectLabel: string, cwd?: string, opts?: {
    includeAutomated?: boolean;
}): Promise<Entry | null>;
export declare function ensureProjectForPath(store: TimStore, cwd: string): Promise<EnsureProjectForPathResult | null>;
//# sourceMappingURL=session.d.ts.map