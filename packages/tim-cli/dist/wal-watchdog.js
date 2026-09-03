"use strict";
// Predicates shared with scripts/cron/tim-wal-watchdog.sh.
// Checkpoint: busy flag must be 0. Writer reap: rate over interval, not lifetime bytes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MIN_WRITE_RATE_BPS = void 0;
exports.isStdioMcpCommand = isStdioMcpCommand;
exports.parseCheckpointOutput = parseCheckpointOutput;
exports.checkpointOutputMeansFailure = checkpointOutputMeansFailure;
exports.computeWriteRateBytesPerSec = computeWriteRateBytesPerSec;
exports.stdioWritersToReap = stdioWritersToReap;
function isStdioMcpCommand(cmd) {
    return cmd.includes('tim-mcp') && cmd.includes('dist/server.js') && !cmd.includes('--http');
}
/** Default: 512 KiB/s sustained over the sample window. */
exports.DEFAULT_MIN_WRITE_RATE_BPS = 512 * 1024;
function parseCheckpointOutput(output) {
    const trimmed = output.trim();
    if (!trimmed || trimmed.includes('timeout'))
        return null;
    const match = trimmed.match(/^(\d+)\s*[|\s]\s*(\d+)\s*[|\s]\s*(\d+)/);
    if (!match)
        return null;
    return {
        busy: Number(match[1]),
        log: Number(match[2]),
        checkpointed: Number(match[3]),
    };
}
/** Success requires a valid three-integer result with busy flag 0. */
function checkpointOutputMeansFailure(output) {
    const parsed = parseCheckpointOutput(output);
    return parsed === null || parsed.busy !== 0;
}
function computeWriteRateBytesPerSec(beforeBytes, afterBytes, intervalMs) {
    if (intervalMs <= 0)
        return 0;
    return Math.max(0, ((afterBytes - beforeBytes) * 1000) / intervalMs);
}
/**
 * Orphans (PPID 1) are always reaped. Live-parent runaway: highest current
 * write rate over the sample window. Ambiguous ties or insufficient rate → nobody.
 */
function stdioWritersToReap(sample, opts) {
    const minRate = opts?.minRateBytesPerSec ?? exports.DEFAULT_MIN_WRITE_RATE_BPS;
    const stdioAfter = sample.after.filter((p) => isStdioMcpCommand(p.cmd));
    const stdioBefore = sample.before.filter((p) => isStdioMcpCommand(p.cmd));
    const beforeByPid = new Map(stdioBefore.map((p) => [p.pid, p]));
    const orphans = stdioAfter.filter((p) => p.ppid === '1').map((p) => p.pid);
    if (orphans.length > 0)
        return orphans;
    const liveRates = [];
    for (const after of stdioAfter.filter((p) => p.ppid !== '1')) {
        const before = beforeByPid.get(after.pid);
        if (!before)
            continue;
        const rate = computeWriteRateBytesPerSec(before.writeBytes, after.writeBytes, sample.intervalMs);
        if (rate >= minRate) {
            liveRates.push({ pid: after.pid, rate });
        }
    }
    if (liveRates.length === 0)
        return [];
    liveRates.sort((a, b) => b.rate - a.rate);
    const top = liveRates[0];
    if (liveRates.length > 1 && liveRates[1].rate >= top.rate * 0.8) {
        return [];
    }
    return [top.pid];
}
//# sourceMappingURL=wal-watchdog.js.map