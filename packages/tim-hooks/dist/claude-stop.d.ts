import type { TimStore } from 'tim-store';
import { type CadenceResult } from './cadence-runner.js';
/** Tail window, not a file-size limit: only the last turn is needed. */
export declare const MAX_TRANSCRIPT_BYTES: number;
export declare const MAX_EXCHANGE_CHARS: number;
export interface ClaudeStopPayload {
    session_id: string;
    transcript_path: string;
    cwd?: string;
    stop_hook_active?: boolean;
    [key: string]: unknown;
}
export interface ClaudeStopResult extends Partial<CadenceResult> {
    logged: boolean;
    duplicate?: boolean;
}
interface TranscriptTurn {
    user: string;
    assistant: string;
    identity: string;
}
/**
 * Read a Claude Code transcript JSONL and return the last genuine user/assistant turn.
 * Skips isMeta, tool-only assistants and malformed lines. Long transcripts are read
 * from the tail — bailing on size logged nothing at all once a session got going.
 */
export declare function readLastExchange(transcriptPath: string, maxBytes?: number): TranscriptTurn | null;
export declare function runClaudeStop(store: TimStore, payload: ClaudeStopPayload, options: {
    cwd: string;
    agent?: {
        agentName: string;
        harness: string;
    };
}): Promise<ClaudeStopResult>;
/** Test helper: expose counters after stop logging. */
export declare function stopExchangeCount(store: TimStore, sessionId: string): Promise<number>;
export {};
//# sourceMappingURL=claude-stop.d.ts.map