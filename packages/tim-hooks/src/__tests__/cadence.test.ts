import { describe, it, expect } from 'vitest';
import {
  shouldAutoCheckpoint,
  checkpointCadenceReminder,
  getCheckpointEveryN,
  getBriefingMaxTokens,
} from '../cadence.js';

describe('checkpoint cadence', () => {
  it('shouldAutoCheckpoint fires on multiples of everyN', () => {
    expect(shouldAutoCheckpoint(20, 20)).toBe(true);
    expect(shouldAutoCheckpoint(19, 20)).toBe(false);
  });

  it('checkpointCadenceReminder warns in last 3 before N', () => {
    expect(checkpointCadenceReminder(17, 20)).toContain('3 exchange');
    expect(checkpointCadenceReminder(10, 20)).toBeNull();
  });

  it('config defaults for everyN and maxTokens', () => {
    const base = { dbPath: '/tmp/t.db', deviceId: 'd1' };
    expect(getCheckpointEveryN(base)).toBe(20);
    expect(getBriefingMaxTokens(base)).toBe(9000);
    expect(getCheckpointEveryN({ ...base, checkpoint: { everyN: 10 } })).toBe(10);
  });
});
