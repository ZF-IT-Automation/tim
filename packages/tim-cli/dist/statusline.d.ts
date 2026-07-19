import { TimStore } from 'tim-store';
import type { FindMarkerOptions } from 'tim-hooks';
export interface StatuslineCounters {
    project: string;
    exchanges: number;
    batchSize: number;
    batchesSummarized: number;
}
/** DB-authoritative exchange counters (5s in-process cache keyed by session id). */
export declare function resolveStatuslineCounters(store: TimStore, project: string, cwd: string, sessionIdArg?: string): Promise<StatuslineCounters>;
export interface StatusLineInput {
    cwd?: string;
    workspace?: {
        current_dir?: string;
    };
}
export declare function resolveStatuslineCwd(input: StatusLineInput, fallback?: string): string;
/** User exchanges in current batch (1..batch_size at boundary). */
export declare function exchangesInCurrentBatch(exchanges: number, batchSize: number): number;
/** Exchanges until next batch summary trigger. */
export declare function summaryIn(exchanges: number, batchSize: number): number;
export declare function formatTimStatusLine(counters: StatuslineCounters, projectName?: string): string;
export declare function formatNoProjectStatusLine(): string;
/** JSON for Hermes CLI status bar (see packages/tim-hooks/scripts/hermes-cli-tim-statusline.patch). */
export interface HermesStatusJson {
    device: string;
    project: string;
    o_node: string;
    counter: string;
}
export declare function formatHermesStatus(counters: StatuslineCounters | null, projectName?: string): HermesStatusJson;
export declare function statuslineFromCwd(cwd: string, options?: FindMarkerOptions, sessionIdArg?: string): Promise<string>;
export declare function hermesStatusFromCwd(cwd: string, options?: FindMarkerOptions, sessionIdArg?: string): Promise<HermesStatusJson>;
/** Sync stdin read — reliable when Claude pipes JSON (async iterator can miss short pipes). */
export declare function readStatuslineInputSync(): StatusLineInput;
export interface StatuslineCliOptions {
    cwd?: string;
    sessionId?: string;
    format?: 'text' | 'hermes';
}
export declare function runStatusline(opts?: StatuslineCliOptions): Promise<void>;
//# sourceMappingURL=statusline.d.ts.map