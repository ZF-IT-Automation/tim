"use strict";
// TIM Sync Engine — v0.1.0-alpha
// Deterministic write-timestamp LWW + Merkle tree delta detection.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMerkleTree = buildMerkleTree;
exports.getMerkleRoot = getMerkleRoot;
exports.resolveLWW = resolveLWW;
exports.mergeStaging = mergeStaging;
exports.computeDelta = computeDelta;
exports.isInSync = isInSync;
exports.syncCycle = syncCycle;
const crypto_1 = require("crypto");
function buildMerkleTree(records) {
    if (records.length === 0)
        return null;
    // Leaf hashes: hash(key + lwwTimestamp + lwwDevice)
    const leaves = records.map(r => sha256(`${r.key}:${r.lwwTimestamp}:${r.lwwDevice}`));
    // Build tree bottom-up
    let level = leaves;
    while (level.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 < level.length) {
                nextLevel.push(sha256(level[i] + level[i + 1]));
            }
            else {
                nextLevel.push(level[i]); // odd leaf — carry up
            }
        }
        level = nextLevel;
    }
    return { hash: level[0] };
}
function getMerkleRoot(records) {
    const tree = buildMerkleTree(records);
    return tree?.hash ?? null;
}
/**
 * Resolve conflict between two staging records for the same key.
 * Strategy: higher lwwTimestamp wins; on tie, lexicographically higher lwwDevice wins.
 * Purely deterministic — no wall-clock decay or confidence weighting.
 */
function resolveLWW(a, b) {
    if (a.lwwTimestamp > b.lwwTimestamp) {
        return { winner: a, loser: b, reason: 'newer_timestamp' };
    }
    if (b.lwwTimestamp > a.lwwTimestamp) {
        return { winner: b, loser: a, reason: 'newer_timestamp' };
    }
    if (a.lwwDevice > b.lwwDevice) {
        return { winner: a, loser: b, reason: 'only_one' };
    }
    if (b.lwwDevice > a.lwwDevice) {
        return { winner: b, loser: a, reason: 'only_one' };
    }
    return { winner: a, loser: b, reason: 'only_one' };
}
/**
 * Merge two sets of staging records, resolving conflicts.
 * Returns the resolved set (winners only).
 */
function mergeStaging(local, remote) {
    const map = new Map();
    // Index by key
    for (const record of local) {
        map.set(record.key, record);
    }
    for (const record of remote) {
        const existing = map.get(record.key);
        if (existing) {
            const resolution = resolveLWW(existing, record);
            map.set(record.key, resolution.winner);
        }
        else {
            map.set(record.key, record);
        }
    }
    return [...map.values()];
}
// ─── Delta Detection ─────────────────────────────────────
/**
 * Find which records changed since the given cursor.
 * Returns records after cursor AND their merkle root.
 */
function computeDelta(records, cursor) {
    const delta = records.filter(r => r.rowid !== undefined
        ? r.rowid > cursor
        : r.lwwTimestamp > cursor);
    return {
        records: delta,
        merkleRoot: getMerkleRoot(delta),
    };
}
/**
 * Check if two devices are in sync by comparing merkle roots.
 */
function isInSync(localRoot, remoteRoot) {
    return localRoot === remoteRoot;
}
// ─── Utility ─────────────────────────────────────────────
function sha256(input) {
    return (0, crypto_1.createHash)('sha256').update(input).digest('hex');
}
/**
 * Full sync cycle: push local changes, pull remote changes,
 * resolve conflicts, return result.
 */
function syncCycle(localUnacked, remoteRecords, localCursor) {
    const conflicts = [];
    // Build index of local unacked by key
    const localMap = new Map();
    for (const r of localUnacked)
        localMap.set(r.key, r);
    // Process remote records
    const toApply = [];
    for (const remote of remoteRecords) {
        const local = localMap.get(remote.key);
        if (local) {
            const resolution = resolveLWW(local, remote);
            conflicts.push(resolution);
            toApply.push(resolution.winner);
            localMap.delete(remote.key); // handled
        }
        else {
            toApply.push(remote);
        }
    }
    // Remaining local records (no remote conflict)
    for (const [, local] of localMap) {
        toApply.push(local);
    }
    const merged = toApply;
    return {
        merged,
        result: {
            pushed: localUnacked.length,
            pulled: remoteRecords.length,
            conflicts,
            merkleRoot: getMerkleRoot(merged),
        },
    };
}
//# sourceMappingURL=sync.js.map