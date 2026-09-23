import { describe, it, expect } from 'vitest';
import {
  isSubstantiveSession,
  sessionHasHandoffNote,
  SUBSTANTIVE_MIN_EXCHANGES,
} from '../substantive-session.js';

describe('isSubstantiveSession', () => {
  it('requires at least SUBSTANTIVE_MIN_EXCHANGES turns without a handoff', () => {
    expect(SUBSTANTIVE_MIN_EXCHANGES).toBe(3);
    expect(isSubstantiveSession(0, false)).toBe(false);
    expect(isSubstantiveSession(1, false)).toBe(false);
    expect(isSubstantiveSession(2, false)).toBe(false);
    expect(isSubstantiveSession(3, false)).toBe(true);
    expect(isSubstantiveSession(10, false)).toBe(true);
  });

  it('treats a 0-turn session with handoff as substantive', () => {
    expect(isSubstantiveSession(0, true)).toBe(true);
    expect(isSubstantiveSession(1, true)).toBe(true);
  });

  it('sessionHasHandoffNote reads summary-root metadata', () => {
    expect(sessionHasHandoffNote({ handoff_note: '  done  ' })).toBe(true);
    expect(sessionHasHandoffNote({ handoff_note: '' })).toBe(false);
    expect(sessionHasHandoffNote({ handoff_note: '   ' })).toBe(false);
    expect(sessionHasHandoffNote(undefined)).toBe(false);
  });
});
