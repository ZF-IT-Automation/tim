"use strict";
// Process-level error handling for the MCP server.
//
// A broken stdio pipe (parent died, stdout closed) used to be logged as an
// uncaughtException and the process stayed alive. Each subsequent stdout write
// threw EPIPE again, and the handler wrote another error_log row. That loop
// produced 2.2 million rows and a 69 GB WAL. Broken-pipe errors must exit
// without touching the database.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBrokenPipeError = isBrokenPipeError;
exports.handleUncaughtException = handleUncaughtException;
exports.handleStdioStreamError = handleStdioStreamError;
function isBrokenPipeError(err) {
    const code = err?.code;
    return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED';
}
function handleUncaughtException(err, log, exit) {
    console.error('[tim-mcp] uncaughtException:', err.stack ?? err.message);
    if (isBrokenPipeError(err)) {
        exit(1);
        return;
    }
    log(err);
}
/** stdout/stderr 'error' — same rule as uncaughtException: broken pipe exits, no DB write. */
function handleStdioStreamError(err, exit) {
    if (isBrokenPipeError(err)) {
        exit(1);
        return;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[tim-mcp] stdio stream error:', message);
}
//# sourceMappingURL=process-error-guards.js.map