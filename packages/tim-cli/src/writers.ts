// Fail-closed TIM MCP writer discovery for destructive maintenance.

import { execFileSync } from 'child_process';
import { isTimMcpWriterPid, WRITER_CANDIDATE_PATTERN } from './mcp-writer-process.js';

export function parseWriterPids(pgrepOutput: string): string[] {
  return pgrepOutput.trim().split(/\s+/).filter(Boolean);
}

export type WriterDiscoveryResult =
  | { ok: true; pids: string[] }
  | { ok: false; error: string };

/**
 * Discover tim-mcp writer PIDs via pgrep + /proc script-path resolution.
 * pgrep exit 1 (no matches) → empty list. Any other failure → fatal.
 */
export function discoverTimMcpWriters(
  execPgrep: () => string = () =>
    execFileSync('pgrep', ['-f', WRITER_CANDIDATE_PATTERN], { encoding: 'utf8' }),
  isWriter: (pid: string) => boolean = (pid) => isTimMcpWriterPid(pid),
): WriterDiscoveryResult {
  try {
    const out = execPgrep();
    const candidates = parseWriterPids(out);
    const pids = candidates.filter(isWriter);
    return { ok: true, pids };
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

export {
  isTimMcpWriterPid,
  resolveMcpServerScriptPath,
  isTimMcpServerScript,
  WRITER_CANDIDATE_PATTERN,
} from './mcp-writer-process.js';
