"use strict";
// Predicates shared with scripts/cron/tim-wal-watchdog.sh.
// Keep the bash copy in lockstep: timeout/empty checkpoint is failure,
// and only stdio writers (not the HTTP daemon) may be reaped.
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkpointOutputMeansFailure = checkpointOutputMeansFailure;
exports.isStdioMcpCommand = isStdioMcpCommand;
exports.stdioWritersToReap = stdioWritersToReap;
function checkpointOutputMeansFailure(output) {
    const trimmed = output.trim();
    return trimmed === '' || trimmed.includes('timeout');
}
function isStdioMcpCommand(cmd) {
    return cmd.includes('tim-mcp') && cmd.includes('dist/server.js') && !cmd.includes('--http');
}
/**
 * Orphans (PPID 1) all go. A live-parent runaway is the single stdio writer
 * with the highest write_bytes. Quiet Cursor/Claude clients stay.
 */
function stdioWritersToReap(procs) {
    const stdio = procs.filter((p) => isStdioMcpCommand(p.cmd));
    const orphans = stdio.filter((p) => p.ppid === '1').map((p) => p.pid);
    if (orphans.length > 0)
        return orphans;
    const live = stdio.filter((p) => p.ppid !== '1');
    if (live.length === 0)
        return [];
    live.sort((a, b) => b.writeBytes - a.writeBytes);
    const top = live[0];
    if (top.writeBytes <= 0)
        return [];
    return [top.pid];
}
//# sourceMappingURL=wal-watchdog.js.map