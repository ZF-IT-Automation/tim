import type { TimStore } from 'tim-store';
import { type CadenceResult } from './cadence-runner.js';
/**
 * Codex 0.147 has no turn-end hook event — its hook surface stops at
 * SessionStart/UserPromptSubmit/SessionEnd, and hooks are skipped entirely
 * until the user grants them persisted trust. The `notify` program in
 * config.toml is the only turn-end callback, it needs no trust, and it already
 * carries the whole exchange, so there is no transcript to parse.
 */
export interface CodexNotifyPayload {
    type?: string;
    'thread-id'?: string;
    'turn-id'?: string;
    cwd?: string;
    'input-messages'?: string[];
    'last-assistant-message'?: string;
    [key: string]: unknown;
}
export interface CodexNotifyResult extends Partial<CadenceResult> {
    logged: boolean;
    duplicate?: boolean;
}
/**
 * Parse the notify payload out of the argv Codex spawns the program with: it
 * appends the JSON as the final argument, so the command array itself may be
 * spelled any way the installer likes.
 */
export declare function parseCodexNotifyArgs(args: string[]): CodexNotifyPayload | null;
export declare function runCodexNotify(store: TimStore, payload: CodexNotifyPayload, options: {
    cwd: string;
}): Promise<CodexNotifyResult>;
//# sourceMappingURL=codex-notify.d.ts.map