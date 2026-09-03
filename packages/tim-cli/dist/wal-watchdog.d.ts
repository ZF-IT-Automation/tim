export declare function checkpointOutputMeansFailure(output: string): boolean;
export declare function isStdioMcpCommand(cmd: string): boolean;
export interface McpProc {
    pid: string;
    ppid: string;
    cmd: string;
    writeBytes: number;
}
/**
 * Orphans (PPID 1) all go. A live-parent runaway is the single stdio writer
 * with the highest write_bytes. Quiet Cursor/Claude clients stay.
 */
export declare function stdioWritersToReap(procs: McpProc[]): string[];
//# sourceMappingURL=wal-watchdog.d.ts.map