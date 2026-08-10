/**
 * cursor-agent 2026.08 has a real turn-end hook (`stop`) — but only in the
 * interactive TUI. Under `cursor-agent -p` no `stop`, `beforeSubmitPrompt` or
 * `afterAgentResponse` fires at all; the only turn-end signal there is
 * `sessionEnd`, which the process emits per invocation. So both are registered
 * with the same command and the exchange dedupe absorbs the double fire when a
 * TUI session ends. Cursor's hooks.json is flat — event name to command list —
 * and other tooling (hmem, o9k) owns entries in it, so nothing here overwrites.
 *
 * `hook cursor-stop` also checkpoints the session when the payload's
 * `hook_event_name` is `sessionEnd` — Cursor's equivalent of Claude's SessionEnd.
 * That is why no separate session-end entry is registered: one command keeps the
 * checkpoint ordered after the exchange it summarizes.
 */
export interface CursorInstallStep {
    step: 'session-start-hook' | 'turn-end-hooks';
    status: 'installed' | 'unchanged' | 'skip';
    path: string;
    detail?: string;
}
export interface CursorHooksInstallResult {
    ok: boolean;
    steps: CursorInstallStep[];
    notes: string[];
}
/** Cursor fires the turn-end hook per turn in the TUI, once per run under -p. */
export declare const TURN_END_EVENTS: readonly ["stop", "sessionEnd"];
interface CursorHookCommand {
    command: string;
    timeout?: number;
    [key: string]: unknown;
}
interface CursorHooksFile {
    version?: number;
    hooks?: Record<string, CursorHookCommand[]>;
    [key: string]: unknown;
}
export declare function cursorHome(): string;
/** Cursor is present if it left a home behind or is on PATH. */
export declare function detectCursor(home?: string): boolean;
/**
 * Absolute node, like the Codex installer writes: hooks spawn without a login
 * shell, so a version-managed node is not on the PATH they inherit.
 */
export declare function cursorStopCommand(cli?: string, node?: string): string;
/** Matches on the script name, so a hand-placed session-start hook is reused. */
export declare function mergeCursorSessionStart(file: CursorHooksFile, command: string): CursorHooksFile;
export declare function mergeCursorTurnEnd(file: CursorHooksFile, command: string): CursorHooksFile;
export declare function installCursorSessionStartHook(options?: {
    hooksPath?: string;
    script?: string;
}): CursorInstallStep;
export declare function installCursorTurnEndHooks(options?: {
    hooksPath?: string;
    cli?: string;
}): CursorInstallStep;
export declare function installCursorHooks(options?: {
    hooksPath?: string;
    cli?: string;
    script?: string;
}): CursorHooksInstallResult;
export {};
//# sourceMappingURL=cursor-hooks-install.d.ts.map