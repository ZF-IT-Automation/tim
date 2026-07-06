import type { HooksConfig } from 'tim-core';
import type { TimStore } from 'tim-store';
export interface HookEnv {
    TIM_SESSION_ID?: string;
    TIM_CWD?: string;
    TIM_AGENT?: string;
    TIM_HARNESS?: string;
    [key: string]: string | undefined;
}
export interface RunHooksOptions {
    scripts?: string | string[];
    env?: HookEnv;
    timeoutMs?: number;
    cwd?: string;
}
export interface HookRunResult {
    script: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    error?: string;
}
export declare function runHookScript(script: string, options?: Omit<RunHooksOptions, 'scripts'>): Promise<HookRunResult>;
export declare function runHooks(options?: RunHooksOptions): Promise<HookRunResult[]>;
export declare function runConfiguredHooks(hookName: keyof Pick<HooksConfig, 'sessionStart' | 'sessionEnd'>, hooksConfig: HooksConfig | undefined, env: HookEnv): Promise<HookRunResult[]>;
interface EmbeddingOptions {
    batchSize?: number;
    model?: string;
}
/**
 * Background hook: finds unembedded content entries and computes their
 * vectors via fastembed (local ONNX). Runs in the summarizer-style
 * fallback chain — best-effort, never blocks user flows.
 *
 * Set TIM_EMBEDDING_DISABLED=1 to skip entirely.
 */
export declare function embedUnembeddedEntries(store: TimStore, opts?: EmbeddingOptions): Promise<number>;
export {};
//# sourceMappingURL=hooks.d.ts.map