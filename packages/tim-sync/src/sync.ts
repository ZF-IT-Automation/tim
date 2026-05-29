// TIM Sync Engine — v0.1.0-alpha
// Confidence-weighted LWW + Merkle tree delta detection.

import { createHash } from 'crypto';
import type { StagingRecord, Entry, Edge } from 'tim-core';

// ─── Merkle Tree ────────────────────────────────────────

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
}

export function buildMerkleTree(records: StagingRecord[]): MerkleNode | null {
  if (records.length === 0) return null;

  // Leaf hashes: hash(key + lwwTimestamp + lwwDevice)
  const leaves: string[] = records.map(r =>
    sha256(`${r.key}:${r.lwwTimestamp}:${r.lwwDevice}`)
  );

  // Build tree bottom-up
  let level = leaves;

  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(sha256(level[i] + level[i + 1]));
      } else {
        nextLevel.push(level[i]); // odd leaf — carry up
      }
    }
    level = nextLevel;
  }

  return { hash: level[0] };
}

export function getMerkleRoot(records: StagingRecord[]): string | null {
  const tree = buildMerkleTree(records);
  return tree?.hash ?? null;
}

// ─── Confidence-Weighted LWW ─────────────────────────────

export interface ConflictResolution {
  winner: StagingRecord;
  loser: StagingRecord | null;
  reason: 'newer_timestamp' | 'higher_confidence' | 'only_one';
}

/**
 * Resolve conflict between two staging records for the same key.
 * Strategy: confidence * time_decay → highest score wins.
 */
export function resolveLWW(a: StagingRecord, b: StagingRecord): ConflictResolution {
  const now = Date.now();

  // Time decay: entries older than 7 days lose weight
  function decay(ts: number): number {
    const ageHours = (now - ts) / 3600_000;
    if (ageHours < 1) return 1.0;
    if (ageHours > 168) return 0.1; // 7 days → 10% weight
    return 1.0 - (ageHours / 168) * 0.9; // linear decay
  }

  const scoreA = a.lwwConfidence * decay(a.lwwTimestamp);
  const scoreB = b.lwwConfidence * decay(b.lwwTimestamp);

  if (scoreA > scoreB) {
    return { winner: a, loser: b, reason: 'higher_confidence' };
  } else if (scoreB > scoreA) {
    return { winner: b, loser: a, reason: 'higher_confidence' };
  }

  // Tiebreaker: newer timestamp
  if (a.lwwTimestamp > b.lwwTimestamp) {
    return { winner: a, loser: b, reason: 'newer_timestamp' };
  }
  return { winner: b, loser: a, reason: 'newer_timestamp' };
}

/**
 * Merge two sets of staging records, resolving conflicts.
 * Returns the resolved set (winners only).
 */
export function mergeStaging(
  local: StagingRecord[],
  remote: StagingRecord[]
): StagingRecord[] {
  const map = new Map<string, StagingRecord>();

  // Index by key
  for (const record of local) {
    map.set(record.key, record);
  }

  for (const record of remote) {
    const existing = map.get(record.key);
    if (existing) {
      const resolution = resolveLWW(existing, record);
      map.set(record.key, resolution.winner);
    } else {
      map.set(record.key, record);
    }
  }

  return [...map.values()];
}

// ─── Sync Protocol ───────────────────────────────────────

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

// ─── Delta Detection ─────────────────────────────────────

/**
 * Find which records changed since the given cursor.
 * Returns records after cursor AND their merkle root.
 */
export function computeDelta(
  records: StagingRecord[],
  cursor: number
): { records: StagingRecord[]; merkleRoot: string | null } {
  const delta = records.filter(r =>
    (r as any).rowid !== undefined
      ? (r as any).rowid > cursor
      : r.lwwTimestamp > cursor
  );

  return {
    records: delta,
    merkleRoot: getMerkleRoot(delta),
  };
}

/**
 * Check if two devices are in sync by comparing merkle roots.
 */
export function isInSync(localRoot: string, remoteRoot: string): boolean {
  return localRoot === remoteRoot;
}

// ─── Utility ─────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ─── Sync Result ─────────────────────────────────────────

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
export function syncCycle(
  localUnacked: StagingRecord[],
  remoteRecords: StagingRecord[],
  localCursor: number
): { merged: StagingRecord[]; result: SyncResult } {
  const conflicts: ConflictResolution[] = [];

  // Build index of local unacked by key
  const localMap = new Map<string, StagingRecord>();
  for (const r of localUnacked) localMap.set(r.key, r);

  // Process remote records
  const toApply: StagingRecord[] = [];
  for (const remote of remoteRecords) {
    const local = localMap.get(remote.key);
    if (local) {
      const resolution = resolveLWW(local, remote);
      conflicts.push(resolution);
      toApply.push(resolution.winner);
      localMap.delete(remote.key); // handled
    } else {
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
