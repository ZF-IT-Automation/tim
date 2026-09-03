"use strict";
// Predicates shared with scripts/cron/tim-wal-watchdog.sh.
// Keep the bash copy in lockstep: timeout/empty checkpoint is failure,
// and only stdio writers (not the HTTP daemon) may be reaped.
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkpointOutputMeansFailure = checkpointOutputMeansFailure;
exports.isStdioMcpCommand = isStdioMcpCommand;
function checkpointOutputMeansFailure(output) {
    const trimmed = output.trim();
    return trimmed === '' || trimmed.includes('timeout');
}
function isStdioMcpCommand(cmd) {
    return cmd.includes('tim-mcp') && cmd.includes('dist/server.js') && !cmd.includes('--http');
}
//# sourceMappingURL=wal-watchdog.js.map