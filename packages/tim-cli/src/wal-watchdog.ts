// Predicates shared with scripts/cron/tim-wal-watchdog.sh.
// Keep the bash copy in lockstep: timeout/empty checkpoint is failure,
// and only stdio writers (not the HTTP daemon) may be reaped.

export function checkpointOutputMeansFailure(output: string): boolean {
  const trimmed = output.trim();
  return trimmed === '' || trimmed.includes('timeout');
}

export function isStdioMcpCommand(cmd: string): boolean {
  return cmd.includes('tim-mcp') && cmd.includes('dist/server.js') && !cmd.includes('--http');
}
