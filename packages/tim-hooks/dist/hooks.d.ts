import type { HooksConfig } from 'tim-core';
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
//# sourceMappingURL=hooks.d.ts.map