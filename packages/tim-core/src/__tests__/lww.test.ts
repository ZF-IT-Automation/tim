// TIM Core LWW tests — moved from packages/tim-sync/src/__tests__/sync.test.ts
// as part of Plan 7 (resolveLWW relocation to tim-core).

import { describe, it, expect } from 'vitest';
import { resolveLWW } from '../lww.js';
import type { StagingRecord } from '../index.js';

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
    expect(result.reason).toBe('device_tiebreak');
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
