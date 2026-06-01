import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export type ExchangeRole = 'user' | 'agent';
export interface Exchange {
    role: ExchangeRole;
    content: string;
}
export type Summarizer = (exchanges: Entry[]) => Promise<string>;
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
export declare class SessionManager {
    private store;
    constructor(store: TimStore);
    sessionStart(params: SessionStartParams): Promise<Entry>;
    startProjectSession(params: ProjectSessionParams): Promise<Entry>;
    sessionLog(sessionId: string, entries: Exchange[]): Promise<Entry[]>;
    /** Fire-and-forget: spawn external summarizer for a full batch. Placeholder until summarizer-agent is built. */
    private summarizeBatch;
    logExchange(sessionId: string, entries: Exchange[]): Promise<Entry[]>;
    showUnsummarized(sessionId: string): Promise<UnsummarizedBatch>;
    writeBatchSummary(sessionId: string, batchIndex: number, summaryText: string, range: {
        seqFrom: number;
        seqTo: number;
    }): Promise<Entry>;
    rollUpSession(sessionId: string, fold: (batches: Entry[]) => Promise<string>): Promise<Entry>;
    getSessionExchanges(sessionId: string): Promise<Entry[]>;
    checkpoint(sessionId: string, opts?: {
        summarize?: Summarizer;
        runDecay?: boolean;
    }): Promise<Entry>;
}
//# sourceMappingURL=session.d.ts.map