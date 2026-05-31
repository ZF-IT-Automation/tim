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
export declare class SessionManager {
    private store;
    constructor(store: TimStore);
    sessionStart(params: SessionStartParams): Promise<Entry>;
    sessionLog(sessionId: string, entries: Exchange[]): Promise<Entry[]>;
    getSessionExchanges(sessionId: string): Promise<Entry[]>;
    checkpoint(sessionId: string, opts?: {
        summarize?: Summarizer;
        runDecay?: boolean;
    }): Promise<Entry>;
}
//# sourceMappingURL=session.d.ts.map