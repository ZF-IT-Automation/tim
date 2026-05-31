import type { TimConfig } from './index.js';
export interface HooksConfig {
    sessionStart?: string | string[];
    sessionEnd?: string | string[];
    enabled?: boolean;
    timeoutMs?: number;
}
export interface TimConfigFile extends TimConfig {
    hooks?: HooksConfig;
}
export declare function getTimDir(): string;
export declare function getConfigPath(): string;
export declare function loadConfig(): TimConfigFile;
export declare function saveConfig(config: TimConfigFile): void;
export declare function normalizeHookScripts(scripts: string | string[] | undefined): string[];
export declare function hooksEnabled(config: TimConfigFile): boolean;
//# sourceMappingURL=config.d.ts.map