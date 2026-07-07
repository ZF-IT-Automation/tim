export interface AutoInitResult {
    ok: boolean;
    dbCreated: boolean;
    configCreated: boolean;
    error?: string;
}
/**
 * Zero-config bootstrap: create DB + default config on first connect.
 * Never throws — server must start even when init fails.
 */
export declare function runAutoInit(options?: {
    dbPath?: string;
}): Promise<AutoInitResult>;
//# sourceMappingURL=auto-init.d.ts.map