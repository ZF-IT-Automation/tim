/** VACUUM may need roughly the current file size in free space. */
export declare const VACUUM_HEADROOM_FACTOR = 1.1;
export declare function vacuumHasRoom(dbBytes: number, freeBytes: number): boolean;
export declare function planCompactErrorLog(opts: {
    dbPath: string;
    maxEntries: number;
    vacuum: boolean;
    freeBytes?: number;
}): {
    ok: true;
    plan: string[];
} | {
    ok: false;
    error: string;
};
export declare function cmdCompactErrorLog(args: string[]): Promise<void>;
//# sourceMappingURL=compact-error-log.d.ts.map