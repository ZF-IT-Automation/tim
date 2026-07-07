export declare function resolveDbPath(): string;
/**
 * Run a hot SQLite backup using the online backup API.
 * Returns { ok, error?, bytes, durationMs }.
 */
export declare function runSnapshot(opts?: {
    dbPath?: string;
    snapshotDir?: string;
    pruneHours?: number;
    noSymlink?: boolean;
    quiet?: boolean;
}): Promise<{
    ok: boolean;
    target?: string;
    bytes?: number;
    durationMs?: number;
    error?: string;
    pruned?: number;
}>;
export declare function cmdSnapshot(args: string[]): Promise<void>;
//# sourceMappingURL=snapshot.d.ts.map