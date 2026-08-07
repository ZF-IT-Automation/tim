/**
 * Codex 0.147 has no turn-end hook event, and the hooks it does have are
 * skipped until the user grants them persisted trust. So exchange logging goes
 * through `notify` in config.toml — a turn-end callback that needs no trust —
 * and the session-start briefing goes through hooks.json, which will stay inert
 * until trusted. Both files have other owners (o9k), so nothing here overwrites.
 */
export interface CodexInstallStep {
    step: 'notify' | 'session-start-hook';
    status: 'installed' | 'unchanged' | 'skip';
    path: string;
    detail?: string;
}
export interface CodexHooksInstallResult {
    ok: boolean;
    steps: CodexInstallStep[];
    notes: string[];
}
export declare function codexHome(): string;
/** Codex is present if it left a home behind or is on PATH. */
export declare function detectCodex(home?: string): boolean;
/**
 * Absolute node, like the MCP installer writes: `notify` spawns without a login
 * shell, so a version-managed node is not on the PATH it inherits.
 */
export declare function codexNotifyLine(cli?: string, node?: string): string;
/**
 * `notify` is a single top-level key, so it must go above the first `[table]`
 * header — appending at EOF would bury it inside whatever section ends the file.
 */
export declare function mergeCodexNotify(existing: string, line: string): string;
export declare function installCodexNotify(options?: {
    configPath?: string;
    cli?: string;
}): CodexInstallStep;
interface CodexHookCommand {
    type: string;
    command: string;
    timeout?: number;
}
interface CodexMatcherGroup {
    matcher?: string;
    hooks: CodexHookCommand[];
}
interface CodexHooksFile {
    hooks?: Record<string, CodexMatcherGroup[]>;
    [key: string]: unknown;
}
/**
 * The entry may already be there under a hand-placed path, so match on the
 * script name rather than the exact command string — an exact match would
 * install a second session-start hook next to the existing one.
 */
export declare function mergeCodexSessionStart(file: CodexHooksFile, command: string): CodexHooksFile;
export declare function installCodexSessionStartHook(options?: {
    hooksPath?: string;
    script?: string;
}): CodexInstallStep;
export declare function installCodexHooks(options?: {
    configPath?: string;
    hooksPath?: string;
    cli?: string;
    script?: string;
}): CodexHooksInstallResult;
export {};
//# sourceMappingURL=codex-hooks-install.d.ts.map