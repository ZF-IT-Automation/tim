export interface HermesInstallOptions {
    dryRun?: boolean;
    skipBuild?: boolean;
    hermesAgentDir?: string;
    hooksDir?: string;
    configPath?: string;
}
export interface StepResult {
    step: string;
    status: 'ok' | 'skip' | 'warn' | 'fail';
    detail: string;
}
export interface HermesInstallReport {
    steps: StepResult[];
    ok: boolean;
}
/** Resolve packaged scripts dir (npm) or monorepo dev path. */
export declare function resolveHermesScriptsDir(): string;
export declare function resolveTimRepoRoot(scriptsDir: string): string | null;
export declare function ensureCacheHookInConfig(yaml: string): {
    yaml: string;
    changed: boolean;
};
/** Broken TIM patch: @staticmethod landed on _get_tim_status instead of display_width. */
export declare function isHermesCliBroken(cliPy: string): boolean;
export declare function isHermesCliPatched(cliPy: string): boolean;
export declare function isHermesCliHmemPatched(cliPy: string): boolean;
/** Programmatic cli.py patch (Hermes line numbers drift; git patch is reference only). */
export declare function patchHermesCliSource(source: string): {
    source: string;
    changed: boolean;
};
/** Read-only check for `tim doctor` (no writes). */
export declare function auditHermesStatusline(opts?: Pick<HermesInstallOptions, 'hooksDir' | 'configPath' | 'hermesAgentDir'>): {
    installed: boolean;
    issues: string[];
};
export declare function installHermesStatusline(opts?: HermesInstallOptions): Promise<HermesInstallReport>;
export declare function printHermesInstallReport(report: HermesInstallReport): void;
export declare function cmdSetupHermesStatusline(args: string[]): Promise<void>;
//# sourceMappingURL=hermes-statusline-install.d.ts.map