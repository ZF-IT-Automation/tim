import type { TimConfig } from './index.js';
export interface HooksConfig {
    sessionStart?: string | string[];
    sessionEnd?: string | string[];
    enabled?: boolean;
    timeoutMs?: number;
    promptSubmit?: {
        enabled?: boolean;
    };
}
export interface RememberConfig {
    enabled?: boolean;
    chain?: Array<{
        cli: string;
        model: string;
        provider?: string;
    }>;
    timeout_sec?: number;
    hard_timeout_ms?: number;
    maxCandidates?: number;
    topK?: number;
    minConfidence?: number;
    includeBatchSummaries?: boolean;
    searchType?: 'fts';
}
export interface TimConfigFile extends TimConfig {
    hooks?: HooksConfig;
    remember?: RememberConfig;
}
export declare function getTimDir(): string;
export declare function getConfigPath(): string;
export declare function loadConfig(): TimConfigFile;
export declare function saveConfig(config: TimConfigFile): void;
export declare function normalizeHookScripts(scripts: string | string[] | undefined): string[];
export declare function hooksEnabled(config: TimConfigFile): boolean;
//# sourceMappingURL=config.d.ts.map