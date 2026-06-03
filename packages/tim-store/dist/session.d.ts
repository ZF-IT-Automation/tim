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
}
//# sourceMappingURL=session.d.ts.map