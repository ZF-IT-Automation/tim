import type { StagingRecord } from 'tim-core';
export interface MerkleNode {
    hash: string;
    left?: MerkleNode;
    right?: MerkleNode;
}
export declare function buildMerkleTree(records: StagingRecord[]): MerkleNode | null;
export declare function getMerkleRoot(records: StagingRecord[]): string | null;
export interface ConflictResolution {
    winner: StagingRecord;
    loser: StagingRecord | null;
    reason: 'newer_timestamp' | 'higher_confidence' | 'only_one';
}
/**
 * Resolve conflict between two staging records for the same key.
 * Strategy: confidence * time_decay → highest score wins.
 */
export declare function resolveLWW(a: StagingRecord, b: StagingRecord): ConflictResolution;
/**
 * Merge two sets of staging records, resolving conflicts.
 * Returns the resolved set (winners only).
 */
export declare function mergeStaging(local: StagingRecord[], remote: StagingRecord[]): StagingRecord[];
export interface SyncPushRequest {
    deviceId: string;
    merkleRoot: string;
    stagingCursor: number;
    records: StagingRecord[];
}
export interface SyncPushResponse {
    accepted: boolean;
    newMerkleRoot: string;
    conflictCount: number;
    conflicts?: {
        key: string;
        localTimestamp: number;
        remoteTimestamp: number;
        resolution: 'kept_local' | 'accepted_remote' | 'merged';
    }[];
}
export interface SyncPullRequest {
    deviceId: string;
    merkleRoot: string;
    lastCursor: number;
}
export interface SyncPullResponse {
    merkleRoot: string;
    records: StagingRecord[];
    newCursor: number;
    hasMore: boolean;
}
/**
 * Find which records changed since the given cursor.
 * Returns records after cursor AND their merkle root.
 */
export declare function computeDelta(records: StagingRecord[], cursor: number): {
    records: StagingRecord[];
    merkleRoot: string | null;
};
/**
 * Check if two devices are in sync by comparing merkle roots.
 */
export declare function isInSync(localRoot: string, remoteRoot: string): boolean;
export interface SyncResult {
    pushed: number;
    pulled: number;
    conflicts: ConflictResolution[];
    merkleRoot: string | null;
}
/**
 * Full sync cycle: push local changes, pull remote changes,
 * resolve conflicts, return result.
 */
export declare function syncCycle(localUnacked: StagingRecord[], remoteRecords: StagingRecord[], localCursor: number): {
    merged: StagingRecord[];
    result: SyncResult;
};
//# sourceMappingURL=sync.d.ts.map