// Fail-closed TIM MCP writer discovery for destructive maintenance.

import { execFileSync } from 'child_process';

export function parseWriterPids(pgrepOutput: string): string[] {
  return pgrepOutput.trim().split(/\s+/).filter(Boolean);
}

export type WriterDiscoveryResult =
  | { ok: true; pids: string[] }
  | { ok: false; error: string };

const WRITER_PATTERN = 'tim-mcp.*dist/server\\.js';

/**
 * Discover tim-mcp writer PIDs via pgrep.
 * pgrep exit 1 (no matches) → empty list. Any other failure → fatal.
 */
export function discoverTimMcpWriters(
  execPgrep: () => string = () =>
    execFileSync('pgrep', ['-f', WRITER_PATTERN], { encoding: 'utf8' }),
): WriterDiscoveryResult {
  try {
    const out = execPgrep();
    return { ok: true, pids: parseWriterPids(out) };
  } catch (e: unknown) {
    const err = e as { status?: number; code?: string; message?: string };
    if (err.status === 1) {
      return { ok: true, pids: [] };
    }
    const detail = err.message ?? err.code ?? String(e);
    return { ok: false, error: `writer discovery failed: ${detail}` };
  }
}

/** Throws when pgrep itself fails. Empty list only when no writers match. */
export function listTimMcpWriterPids(): string[] {
  const result = discoverTimMcpWriters();
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.pids;
}

export function requireNoWriters(context: string): void {
  const result = discoverTimMcpWriters();
  if (!result.ok) {
    throw new Error(`${context}: ${result.error}`);
  }
  if (result.pids.length > 0) {
    throw new Error(`${context}: writers still hold the DB: ${result.pids.join(' ')}`);
  }
}
