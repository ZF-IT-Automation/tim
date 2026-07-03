// TIM Sync Engine — v0.1.0-alpha
// Deterministic write-timestamp LWW.

import type { StagingRecord } from 'tim-core';

// ─── Deterministic LWW ───────────────────────────────────

export interface ConflictResolution {
  winner: StagingRecord;
  loser: StagingRecord | null;
  reason: 'newer_timestamp' | 'higher_confidence' | 'device_tiebreak';
}

/**
 * Resolve conflict between two staging records for the same key.
 * Strategy: higher lwwTimestamp wins; on tie, lexicographically higher lwwDevice wins.
 * Purely deterministic — no wall-clock decay or confidence weighting.
 */
export function resolveLWW(a: StagingRecord, b: StagingRecord): ConflictResolution {
  if (a.lwwTimestamp > b.lwwTimestamp) {
    return { winner: a, loser: b, reason: 'newer_timestamp' };
  }
  if (b.lwwTimestamp > a.lwwTimestamp) {
    return { winner: b, loser: a, reason: 'newer_timestamp' };
  }
  if (a.lwwDevice > b.lwwDevice) {
    return { winner: a, loser: b, reason: 'device_tiebreak' };
  }
  if (b.lwwDevice > a.lwwDevice) {
    return { winner: b, loser: a, reason: 'device_tiebreak' };
  }
  return { winner: a, loser: b, reason: 'device_tiebreak' };
}

// ─── Sync Protocol ───────────────────────────────────────

export interface SyncPushRequest {
  deviceId: string;
  stagingCursor: number;
  records: StagingRecord[];
}

export interface SyncPushResponse {
  accepted: boolean;
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
  lastCursor: number;
}

export interface SyncPullResponse {
  records: StagingRecord[];
  newCursor: number;
  hasMore: boolean;
}
