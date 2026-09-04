import { describe, it, expect } from 'vitest';
import { backupHasRoom, planCompactErrorLog } from '../compact-error-log.js';

describe('backupHasRoom', () => {
  it('requires free space at least equal to the db size', () => {
    expect(backupHasRoom(1_000_000_000, 500_000_000)).toBe(false);
    expect(backupHasRoom(1_000_000_000, 1_000_000_000)).toBe(true);
    expect(backupHasRoom(1_000_000_000, 2_000_000_000)).toBe(true);
  });
});

describe('planCompactErrorLog backup step', () => {
  it('lists backup before rebuild', () => {
    const result = planCompactErrorLog({
      dbPath: '/tmp/tim.db',
      maxEntries: 5000,
      vacuum: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const backupIdx = result.plan.findIndex((s) => s.includes('backup'));
      const rebuildIdx = result.plan.findIndex((s) => s.includes('rebuild'));
      expect(backupIdx).toBeGreaterThanOrEqual(0);
      expect(rebuildIdx).toBeGreaterThan(backupIdx);
    }
  });
});
