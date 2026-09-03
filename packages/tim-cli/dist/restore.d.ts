export declare function shouldCopyLiveDbForSafety(liveBytes: number, snapshotBytes: number, freeBytes: number): boolean;
/** WAL/SHM must not be unlinked while any tim-mcp process still holds the DB. */
export declare function walSidecarsMayBeDropped(writerPids: string[]): boolean;
export { parseWriterPids } from './writers.js';
export { discoverTimMcpWriters, listTimMcpWriterPids, requireNoWriters } from './writers.js';
export declare function isBenignSidecarUnlinkError(err: unknown): boolean;
/** ENOENT is success (no leftover). Any other unlink error must abort restore. */
export declare function discardWalSidecars(paths: string[], unlink?: (p: string) => void): {
    ok: true;
} | {
    ok: false;
    path: string;
    error: string;
};
export declare function cmdRestoreList(): Promise<void>;
export declare function cmdRestore(args: string[]): Promise<void>;
//# sourceMappingURL=restore.d.ts.map