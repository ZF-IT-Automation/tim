export declare function isStdioMcpCommand(cmd: string): boolean;
export interface McpProc {
    pid: string;
    ppid: string;
    cmd: string;
    writeBytes: number;
}
export interface WriteRateSample {
    before: McpProc[];
    after: McpProc[];
    intervalMs: number;
}
/** Default: 512 KiB/s sustained over the sample window. */
export declare const DEFAULT_MIN_WRITE_RATE_BPS: number;
export declare function parseCheckpointOutput(output: string): {
    busy: number;
    log: number;
    checkpointed: number;
} | null;
/** Success requires a valid three-integer result with busy flag 0. */
export declare function checkpointOutputMeansFailure(output: string): boolean;
export declare function computeWriteRateBytesPerSec(beforeBytes: number, afterBytes: number, intervalMs: number): number;
/**
 * Orphans (PPID 1) are always reaped. Live-parent runaway: highest current
 * write rate over the sample window. Ambiguous ties or insufficient rate → nobody.
 */
export declare function stdioWritersToReap(sample: WriteRateSample, opts?: {
    minRateBytesPerSec?: number;
}): string[];
//# sourceMappingURL=wal-watchdog.d.ts.map