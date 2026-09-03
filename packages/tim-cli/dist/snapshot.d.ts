export declare function resolveDbPath(): string;
/**
 * Delete oldest snapshots until total size is under maxBytes.
 * Always keeps the newest file, even if it alone exceeds the budget.
 */
export declare function pruneToMaxBytes(dir: string, maxBytes: number, log?: (s: string) => void): number;
/**
 * Run a hot SQLite backup using the online backup API.
 * Returns { ok, error?, bytes, durationMs }.
 */
export declare function runSnapshot(opts?: {
    dbPath?: string;
    snapshotDir?: string;
    pruneHours?: number;
    maxBytes?: number;
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