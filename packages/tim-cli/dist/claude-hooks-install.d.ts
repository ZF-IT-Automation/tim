export interface ClaudeHookCommand {
    type: string;
    command: string;
    timeout?: number;
}
export interface ClaudeHookMatcher {
    matcher?: string;
    hooks: ClaudeHookCommand[];
}
export interface ClaudeSettings {
    permissions?: Record<string, unknown>;
    hooks?: {
        UserPromptSubmit?: ClaudeHookMatcher[];
        Stop?: ClaudeHookMatcher[];
        [event: string]: ClaudeHookMatcher[] | undefined;
    };
    [key: string]: unknown;
}
export interface ClaudeHooksInstallResult {
    status: 'installed' | 'unchanged' | 'skipped';
    settingsPath: string;
    backupPath?: string;
    reason?: string;
}
export declare function mergeClaudeHooks(settings: ClaudeSettings): ClaudeSettings;
export declare function installClaudeHooks(options?: {
    settingsPath?: string;
}): ClaudeHooksInstallResult;
//# sourceMappingURL=claude-hooks-install.d.ts.map