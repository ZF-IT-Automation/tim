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

describe('Deterministic LWW', () => {
  it('should prefer newer lwwTimestamp', () => {
    const a = makeRecord({ lwwTimestamp: 100, lwwDevice: 'aaa' });
    const b = makeRecord({ lwwTimestamp: 200, lwwDevice: 'bbb' });
    const result = resolveLWW(a, b);
    expect(result.winner).toBe(b);
    expect(result.reason).toBe('newer_timestamp');
  });

  it('should tiebreak equal timestamps by lexicographic lwwDevice', () => {
    const ts = 5000;
    const a = makeRecord({ lwwTimestamp: ts, lwwDevice: 'aaa' });
    const b = makeRecord({ lwwTimestamp: ts, lwwDevice: 'bbb' });
    const result = resolveLWW(a, b);
    expect(result.winner).toBe(b);
    expect(result.reason).toBe('only_one');
  });

  it('should ignore confidence weighting (older timestamp wins even with low confidence on newer)', () => {
    const a = makeRecord({ lwwTimestamp: 100, lwwConfidence: 0.1, lwwDevice: 'aaa' });
    const b = makeRecord({ lwwTimestamp: 200, lwwConfidence: 1.0, lwwDevice: 'bbb' });
    const result = resolveLWW(a, b);
    expect(result.winner).toBe(b);
    expect(result.reason).toBe('newer_timestamp');
  });

  it('should produce identical results regardless of call time', async () => {
    const a = makeRecord({ lwwTimestamp: 1000, lwwDevice: 'device-a', lwwConfidence: 0.9 });
    const b = makeRecord({ lwwTimestamp: 1000, lwwDevice: 'device-b', lwwConfidence: 0.1 });
    const first = resolveLWW(a, b);
    await new Promise(r => setTimeout(r, 50));
    const second = resolveLWW(a, b);
    expect(first.winner).toBe(second.winner);
    expect(first.reason).toBe(second.reason);
  });

  it('should pick the same winner regardless of argument order', () => {
    const a = makeRecord({ key: 'x', lwwTimestamp: 100, lwwDevice: 'aaa' });
    const b = makeRecord({ key: 'x', lwwTimestamp: 200, lwwDevice: 'bbb' });
    expect(resolveLWW(a, b).winner).toBe(resolveLWW(b, a).winner);
  });
});

describe('mergeStaging', () => {
  it('should merge disjoint records', () => {
    const local = [makeRecord({ key: 'a' })];
    const remote = [makeRecord({ key: 'b' })];
    const merged = mergeStaging(local, remote);
    expect(merged.length).toBe(2);
  });

  it('should resolve conflicts by timestamp', () => {
    const local = makeRecord({ key: 'x', lwwTimestamp: 100, lwwDevice: 'aaa' });
    const remote = makeRecord({ key: 'x', lwwTimestamp: 200, lwwDevice: 'bbb' });

    const merged = mergeStaging([local], [remote]);
    expect(merged.length).toBe(1);
    expect(merged[0].lwwTimestamp).toBe(200);
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

  it('should detect conflicts and resolve by timestamp', () => {
    const local = [makeRecord({ key: 'x', lwwTimestamp: 300, lwwDevice: 'aaa' })];
    const remote = [makeRecord({ key: 'x', lwwTimestamp: 100, lwwDevice: 'bbb' })];

    const { merged, result } = syncCycle(local, remote, 0);
    expect(merged.length).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('newer_timestamp');
    expect(merged[0].lwwTimestamp).toBe(300);
  });

  it('should converge when both devices merge the same conflicting writes', () => {
    const deviceA = 'device-alpha';
    const deviceB = 'device-bravo';
    const key = 'shared-entry';

    const writeA = makeRecord({
      key,
      lwwTimestamp: 1000,
      lwwDevice: deviceA,
      payload: '{"id":"shared-entry","content":"from A"}',
    });
    const writeB = makeRecord({
      key,
      lwwTimestamp: 2000,
      lwwDevice: deviceB,
      payload: '{"id":"shared-entry","content":"from B"}',
    });

    const sideA = mergeStaging([writeA], [writeB]);
    const sideB = mergeStaging([writeB], [writeA]);

    expect(sideA).toHaveLength(1);
    expect(sideB).toHaveLength(1);
    expect(sideA[0].lwwTimestamp).toBe(sideB[0].lwwTimestamp);
    expect(sideA[0].lwwDevice).toBe(sideB[0].lwwDevice);
    expect(sideA[0].payload).toBe(sideB[0].payload);
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
    expect(delta.length).toBe(2);
  });

  it('should detect sync status', () => {
    const records = [makeRecord()];
    const root = getMerkleRoot(records)!;
    expect(isInSync(root, root)).toBe(true);
    expect(isInSync(root, 'different')).toBe(false);
  });
});
