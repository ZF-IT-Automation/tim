import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatEntryId, sessionShortFromMetadata } from '../entry-id.js';

describe('formatEntryId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses ns when no session in metadata', () => {
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-06-01T12:00:00.000Z');
    const id = formatEntryId({ device: 'ubun', metadata: {} });
    expect(id).toMatch(/^ubun-0601-ns-[0-9A-Z]{26}$/);
  });

  it('embeds session_short from metadata.sessionId', () => {
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-06-01T12:00:00.000Z');
    const id = formatEntryId({
      device: 'ubun',
      metadata: { sessionId: 'abc123-session-uuid' },
    });
    expect(id).toMatch(/^ubun-0601-abc123-[0-9A-Z]{26}$/);
    expect(sessionShortFromMetadata({ sessionId: 'abc123-session-uuid' })).toBe('abc123');
  });

  it('accepts metadata.session_id alias', () => {
    expect(sessionShortFromMetadata({ session_id: 'sess99' })).toBe('sess99');
  });
});
