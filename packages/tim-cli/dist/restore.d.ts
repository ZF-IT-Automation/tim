export declare function shouldCopyLiveDbForSafety(liveBytes: number, snapshotBytes: number, freeBytes: number): boolean;
/** WAL/SHM must not be unlinked while any tim-mcp process still holds the DB. */
export declare function walSidecarsMayBeDropped(writerPids: string[]): boolean;
export declare function parseWriterPids(pgrepOutput: string): string[];
export declare function listTimMcpWriterPids(): string[];
export declare function cmdRestoreList(): Promise<void>;
export declare function cmdRestore(args: string[]): Promise<void>;
//# sourceMappingURL=restore.d.ts.map