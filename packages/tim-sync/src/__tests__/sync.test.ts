// TIM Sync Tests — v0.1.0-alpha

import { describe, it, expect } from 'vitest';
import {
  buildMerkleTree, getMerkleRoot,
  resolveLWW, mergeStaging, syncCycle,
  computeDelta, isInSync,
} from '../sync.js';
import type { StagingRecord } from 'tim-core';

function makeRecord(overrides: Partial<StagingRecord> = {}): StagingRecord {
  return {
    key: overrides.key ?? 'entry-1',
    entityType: overrides.entityType ?? 'entry',
    operation: overrides.operation ?? 'upsert',
    payload: overrides.payload ?? '{"id":"1","content":"test"}',
    lwwTimestamp: overrides.lwwTimestamp ?? Date.now(),
    lwwDevice: overrides.lwwDevice ?? 'device-a',
    lwwConfidence: overrides.lwwConfidence ?? 1.0,
    acked: overrides.acked ?? false,
  };
}

describe('Merkle Tree', () => {
  it('should return null for empty records', () => {
    expect(buildMerkleTree([])).toBeNull();
    expect(getMerkleRoot([])).toBeNull();
  });

  it('should produce a deterministic root', () => {
    const records = [makeRecord({ key: 'a' }), makeRecord({ key: 'b' })];
    const root1 = getMerkleRoot(records);
    const root2 = getMerkleRoot(records);
    expect(root1).toBe(root2);
  });

  it('should produce different roots for different records', () => {
    const a = [makeRecord({ key: 'a' })];
    const b = [makeRecord({ key: 'b' })];
    expect(getMerkleRoot(a)).not.toBe(getMerkleRoot(b));
  });

  it('should handle odd number of records', () => {
    const records = [makeRecord(), makeRecord(), makeRecord()];
    const root = getMerkleRoot(records);
    expect(root).toBeTruthy();
    expect(root).toHaveLength(64); // SHA-256 hex
  });
});

describe('Confidence-Weighted LWW', () => {
  it('should prefer higher confidence with same timestamp', () => {
    const now = Date.now();
    const a = makeRecord({ lwwTimestamp: now, lwwConfidence: 0.5 });
    const b = makeRecord({ lwwTimestamp: now, lwwConfidence: 0.9 });
    const result = resolveLWW(a, b);
    expect(result.winner).toBe(b);
    expect(result.reason).toBe('higher_confidence');
  });

  it('should prefer newer timestamp with same confidence', () => {
    const a = makeRecord({ lwwTimestamp: 1000, lwwConfidence: 1.0 });
    const b = makeRecord({ lwwTimestamp: 2000, lwwConfidence: 1.0 });
    const result = resolveLWW(a, b);
    expect(result.winner).toBe(b);
    expect(result.reason).toBe('newer_timestamp');
  });

  it('should prefer higher confidence over newer timestamp when confidence gap is large', () => {
    const now = Date.now();
    const a = makeRecord({ lwwTimestamp: now, lwwConfidence: 0.9 });
    const b = makeRecord({ lwwTimestamp: now + 1000, lwwConfidence: 0.1 });
    const result = resolveLWW(a, b);
    expect(result.winner).toBe(a);
    expect(result.reason).toBe('higher_confidence');
  });
});

describe('mergeStaging', () => {
  it('should merge disjoint records', () => {
    const local = [makeRecord({ key: 'a' })];
    const remote = [makeRecord({ key: 'b' })];
    const merged = mergeStaging(local, remote);
    expect(merged.length).toBe(2);
  });

  it('should resolve conflicts', () => {
    const now = Date.now();
    const local = makeRecord({ key: 'x', lwwTimestamp: now, lwwConfidence: 0.9 });
    const remote = makeRecord({ key: 'x', lwwTimestamp: now, lwwConfidence: 0.1 });

    const merged = mergeStaging([local], [remote]);
    expect(merged.length).toBe(1);
    expect(merged[0].lwwConfidence).toBe(0.9);
  });
});

describe('syncCycle', () => {
  it('should produce merged records', () => {
    const local = [makeRecord({ key: 'a' })];
    const remote = [makeRecord({ key: 'b' })];

    const { merged, result } = syncCycle(local, remote, 0);
    expect(merged.length).toBe(2);
    expect(result.pushed).toBe(1);
    expect(result.pulled).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merkleRoot).toBeTruthy();
  });

  it('should detect conflicts', () => {
    const local = [makeRecord({ key: 'x', lwwConfidence: 0.9 })];
    const remote = [makeRecord({ key: 'x', lwwConfidence: 0.3 })];

    const { merged, result } = syncCycle(local, remote, 0);
    expect(merged.length).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('higher_confidence');
  });
});

describe('delta detection', () => {
  it('should compute delta from cursor', () => {
    const records = [
      makeRecord({ key: 'a', lwwTimestamp: 1000 }),
      makeRecord({ key: 'b', lwwTimestamp: 2000 }),
      makeRecord({ key: 'c', lwwTimestamp: 3000 }),
    ];

    const { records: delta } = computeDelta(records, 1500);
    // Filter works on lwwTimestamp > cursor
    expect(delta.length).toBe(2); // b and c
  });

  it('should detect sync status', () => {
    const records = [makeRecord()];
    const root = getMerkleRoot(records)!;
    expect(isInSync(root, root)).toBe(true);
    expect(isInSync(root, 'different')).toBe(false);
  });
});
