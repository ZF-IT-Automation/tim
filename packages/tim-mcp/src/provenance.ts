// Git provenance for memory entries. Captured at the MCP layer because
// only the MCP process knows the agent's cwd; the store stays git-free.
// Every call shells out once — ~5ms, acceptable at tool-call frequency.

import { execFileSync } from 'node:child_process';

const GIT_OPTS = { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };

export interface Provenance {
  commit: string;      // short hash at write time
  branch?: string;
}

export function captureProvenance(cwd: string): Provenance | null {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, ...GIT_OPTS })
      .toString().trim();
    if (!commit) return null;
    let branch: string | undefined;
    try {
      const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, ...GIT_OPTS })
        .toString().trim();
      branch = b && b !== 'HEAD' ? b : undefined; // 'HEAD' = detached
    } catch {
      branch = undefined;
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
