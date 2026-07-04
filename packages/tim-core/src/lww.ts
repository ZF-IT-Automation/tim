// Deterministic last-writer-wins conflict resolution.
// Strategy: higher lwwTimestamp wins; on tie, lexicographically higher
// lwwDevice wins. Purely deterministic — no wall-clock decay, no
// confidence weighting. Lives in tim-core because both tim-store (apply
// path) and tim-sync-client (transport) need it.

import type { StagingRecord } from './index.js';

export interface ConflictResolution {
  winner: StagingRecord;
  loser: StagingRecord | null;
  reason: 'newer_timestamp' | 'device_tiebreak' | 'only_one';
}

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
  return { winner: a, loser: b, reason: 'only_one' };
}
