export interface ReleaseCheckStep {
    id: string;
    command?: string;
}
export interface ReleaseCheckResult {
    id: string;
    ok: boolean;
    detail: string;
}
export interface ReleaseCheckSummary {
    status: 'OK' | 'BLOCKER';
    blockers: string[];
    results: ReleaseCheckResult[];
}
export interface ReleaseCheckOptions {
    beta?: boolean;
    skipTests?: boolean;
}
export declare function buildReleaseCheckPlan(options?: ReleaseCheckOptions): ReleaseCheckStep[];
export declare function summarizeReleaseCheck(results: ReleaseCheckResult[]): ReleaseCheckSummary;
export declare function runReleaseCheck(options?: ReleaseCheckOptions): Promise<ReleaseCheckSummary>;
//# sourceMappingURL=release-check.d.ts.map