"use strict";
// Git provenance for memory entries. Captured at the MCP layer because
// only the MCP process knows the agent's cwd; the store stays git-free.
// Shells out once per capture; commitsSince is memoised by commit hash.
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureProvenance = captureProvenance;
exports.commitsSince = commitsSince;
exports.commitsSinceCached = commitsSinceCached;
exports.clearCommitsSinceCache = clearCommitsSinceCache;
exports.getCommitsSinceCacheStats = getCommitsSinceCacheStats;
const node_child_process_1 = require("node:child_process");
const GIT_OPTS = { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] };
function captureProvenance(cwd) {
    try {
        const out = (0, node_child_process_1.execFileSync)('git', ['-c', 'core.abbrev=7', 'log', '-1', '--format=%h%n%D'], { cwd, ...GIT_OPTS }).toString().trim();
        if (!out)
            return null;
        const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
        const commit = lines[0];
        if (!commit)
            return null;
        let branch;
        const refLine = lines[1];
        if (refLine) {
            const headMatch = refLine.match(/HEAD -> ([^,]+)/);
            branch = headMatch?.[1]?.trim();
            if (!branch && refLine !== 'HEAD') {
                branch = refLine.split(',')[0]?.trim();
            }
        }
        return branch ? { commit, branch } : { commit };
    }
    catch {
        return null; // not a repo, no git binary, or timeout — provenance is best-effort
    }
}
function commitsSince(cwd, commit) {
    try {
        const out = (0, node_child_process_1.execFileSync)('git', ['rev-list', '--count', `${commit}..HEAD`], { cwd, ...GIT_OPTS })
            .toString().trim();
        const n = Number(out);
        return Number.isFinite(n) ? n : null;
    }
    catch {
        return null; // unknown commit (different repo) or not a repo
    }
}
const driftCache = new Map();
const DRIFT_TTL_MS = 5_000;
let driftCacheHits = 0;
let driftCacheMisses = 0;
function commitsSinceCached(cwd, commit) {
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
function clearCommitsSinceCache() {
    driftCache.clear();
    driftCacheHits = 0;
    driftCacheMisses = 0;
}
/** Test helper — returns cache hit/miss counters since last clear. */
function getCommitsSinceCacheStats() {
    return { hits: driftCacheHits, misses: driftCacheMisses };
}
//# sourceMappingURL=provenance.js.map