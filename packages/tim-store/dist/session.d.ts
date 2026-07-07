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
    logExchange(sessionId: string, entries: Exchange[]): Promise<Entry[]>;
    showUnsummarized(sessionId: string): Promise<UnsummarizedBatch>;
    writeBatchSummary(sessionId: string, batchIndex: number, summaryText: string, range: {
        seqFrom: number;
        seqTo: number;
    }, tags?: string[]): Promise<Entry>;
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
    }): Promise<Entry>;
    /** Upsert session-summary-root content after checkpoint / rollup. */
    updateSessionSummary(sessionId: string, summaryText: string): Promise<Entry>;
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
export declare function ensureProjectForPath(store: TimStore, cwd: string): Promise<EnsureProjectForPathResult | null>;
//# sourceMappingURL=session.d.ts.map