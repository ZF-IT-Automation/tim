// Process-level error handling for the MCP server.
//
// A broken stdio pipe (parent died, stdout closed) used to be logged as an
// uncaughtException and the process stayed alive. Each subsequent stdout write
// threw EPIPE again, and the handler wrote another error_log row. That loop
// produced 2.2 million rows and a 69 GB WAL. Broken-pipe errors must exit
// without touching the database.

export function isBrokenPipeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED';
}

export function handleUncaughtException(
  err: Error,
  log: (err: Error) => void,
  exit: (code: number) => void,
): void {
  console.error('[tim-mcp] uncaughtException:', err.stack ?? err.message);
  if (isBrokenPipeError(err)) {
    exit(1);
    return;
  }
  log(err);
}
