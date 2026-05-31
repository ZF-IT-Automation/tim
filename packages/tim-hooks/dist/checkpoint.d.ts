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
}
/** Resolve active project label from TIM_PROJECT env or ~/.tim/active-project. */
export declare function getActiveProjectLabel(): string | null;
/** Load project entry by hmem-style label (e.g. P0062) when configured. */
export declare function loadProjectContext(store: TimStore): Promise<Entry | null>;
export declare function runCheckpoint(store: TimStore, sessionId: string, opts?: {
    summarize?: Summarizer;
    runDecay?: boolean;
}): Promise<Entry>;
export declare function runSessionStart(store: TimStore, params: {
    sessionId: string;
    agentName: string;
    cwd: string;
    harness: string;
    hooksConfig?: HooksConfig;
}): Promise<SessionStartResult>;
export declare function runSessionEnd(store: TimStore, sessionId: string, opts?: SessionEndOptions): Promise<Entry>;
//# sourceMappingURL=checkpoint.d.ts.map