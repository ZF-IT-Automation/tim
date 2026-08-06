import { describe, it, expect } from 'vitest';
import {
  shouldAutoCheckpoint,
  checkpointCadenceReminder,
  getCheckpointEveryN,
  getBriefingMaxTokens,
  getBriefingRecentSessions,
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

  it('briefing.recentSessions defaults to 5 and is overridable', () => {
    const base = { dbPath: '/tmp/t.db', deviceId: 'd1' };
    expect(getBriefingRecentSessions(base)).toBe(5);
    expect(getBriefingRecentSessions({ ...base, briefing: { recentSessions: 8 } })).toBe(8);
    // Nonsense values fall back to the default rather than hiding all sessions.
    expect(getBriefingRecentSessions({ ...base, briefing: { recentSessions: 0 } })).toBe(5);
    expect(getBriefingRecentSessions({ ...base, briefing: { recentSessions: -3 } })).toBe(5);
  });
});
