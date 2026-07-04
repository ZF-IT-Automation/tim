// Git provenance for memory entries. Captured at the MCP layer because
// only the MCP process knows the agent's cwd; the store stays git-free.
// Shells out once per capture; commitsSince is memoised by commit hash.

import { execFileSync } from 'node:child_process';

const GIT_OPTS = { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };

export interface Provenance {
  commit: string;      // short hash at write time
  branch?: string;
}

export function captureProvenance(cwd: string): Provenance | null {
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.abbrev=7', 'log', '-1', '--format=%h%n%D'],
      { cwd, ...GIT_OPTS },
    ).toString().trim();
    if (!out) return null;
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    const commit = lines[0];
    if (!commit) return null;
    let branch: string | undefined;
    const refLine = lines[1];
    if (refLine) {
      const headMatch = refLine.match(/HEAD -> ([^,]+)/);
      branch = headMatch?.[1]?.trim();
      if (!branch && refLine !== 'HEAD') {
        branch = refLine.split(',')[0]?.trim();
      }
    }
    return branch ? { commit, branch } : { commit };
  } catch {
    return null; // not a repo, no git binary, or timeout — provenance is best-effort
  }
}

export function commitsSince(cwd: string, commit: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${commit}..HEAD`], { cwd, ...GIT_OPTS })
      .toString().trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // unknown commit (different repo) or not a repo
  }
}

const driftCache = new Map<string, { count: number | null; at: number }>();
const DRIFT_TTL_MS = 5_000;
let driftCacheHits = 0;
let driftCacheMisses = 0;

export function commitsSinceCached(cwd: string, commit: string): number | null {
  const cached = driftCache.get(commit);
  if (cached && Date.now() - cached.at < DRIFT_TTL_MS) {
    driftCacheHits++;
    return cached.count;
  }
  driftCacheMisses++;
  const result = commitsSince(cwd, commit);
  driftCache.set(commit, { count: result, at: Date.now() });
  return result;
}

/** Test helper — clears memoisation cache and hit/miss counters. */
export function clearCommitsSinceCache(): void {
  driftCache.clear();
  driftCacheHits = 0;
  driftCacheMisses = 0;
}

/** Test helper — returns cache hit/miss counters since last clear. */
export function getCommitsSinceCacheStats(): { hits: number; misses: number } {
  return { hits: driftCacheHits, misses: driftCacheMisses };
}
