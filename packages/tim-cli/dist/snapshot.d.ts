/** 48h of 2 GB snapshots every 30 min is ~192 GB. Cap on-host copies. */
export declare const DEFAULT_MAX_BYTES: number;
/** Extra free space required beyond the source DB size before creating a snapshot. */
export declare const SNAPSHOT_HEADROOM_BYTES: number;
/**
 * Parse snapshot byte budget from env/CLI.
 * Missing config → documented default. Present but invalid → explicit error.
 */
export type SnapshotBudgetResult = {
    ok: true;
    value: number;
} | {
    ok: false;
    error: string;
};
export declare function parseSnapshotBudgetStrict(raw: string): SnapshotBudgetResult;
export declare function parseSnapshotBudgetFromEnv(raw: string | undefined, fallback: number): SnapshotBudgetResult;
/** @deprecated Use parseSnapshotBudgetFromEnv / parseSnapshotBudgetStrict */
export declare function parseSnapshotBudget(raw: string | undefined, fallback: number): number;
export declare function snapshotHasRoom(opts: {
    sourceBytes: number;
    freeBytes: number;
    headroomBytes?: number;
}): boolean;
/** Online backup copies committed WAL frames; room checks must cover db+WAL. */
export declare function snapshotFootprintBytes(dbPath: string, io?: {
    statDb?: (p: string) => {
        size: number;
    };
    statWal?: (p: string) => {
        size: number;
    };
}): number;
/** Returns free bytes on the filesystem hosting dir. Throws on statfs failure. */
export declare function readFreeBytes(dir: string): number;
/**
 * If the snapshot directory cannot hold another copy of the source DB,
 * prune oldest files first, then abort rather than filling the disk.
 */
export declare function makeRoomForSnapshot(opts: {
    dir: string;
    sourceBytes: number;
    freeBytes: number;
    pruneHours: number;
    maxBytes: number;
    log?: (s: string) => void;
}): {
    ok: boolean;
    pruned: number;
    freeBytes: number;
    error?: string;
};
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
    freeBytes?: number;
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