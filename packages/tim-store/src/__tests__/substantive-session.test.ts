import { describe, it, expect } from 'vitest';
import {
  aggregateSubstance,
  isSubstantiveSession,
  parseSessionSubstance,
  sessionHasHandoffNote,
  SUBSTANTIVE_MIN_EXCHANGES,
} from '../substantive-session.js';

describe('isSubstantiveSession', () => {
  it('requires at least SUBSTANTIVE_MIN_EXCHANGES turns without a handoff or substance', () => {
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

  it('honours summarizer substance verdict over exchange count', () => {
    expect(isSubstantiveSession(2, false, 'real')).toBe(true);
    expect(isSubstantiveSession(5, false, 'none')).toBe(false);
    expect(isSubstantiveSession(2, false, 'low')).toBe(false);
    expect(isSubstantiveSession(4, false, 'low')).toBe(true);
  });

  it('handoff note wins over substance=none', () => {
    expect(isSubstantiveSession(1, true, 'none')).toBe(true);
  });

  it('sessionHasHandoffNote reads summary-root metadata', () => {
    expect(sessionHasHandoffNote({ handoff_note: '  done  ' })).toBe(true);
    expect(sessionHasHandoffNote({ handoff_note: '' })).toBe(false);
    expect(sessionHasHandoffNote({ handoff_note: '   ' })).toBe(false);
    expect(sessionHasHandoffNote(undefined)).toBe(false);
  });
});

describe('parseSessionSubstance', () => {
  it('accepts valid values and rejects garbled input', () => {
    expect(parseSessionSubstance('none')).toBe('none');
    expect(parseSessionSubstance('low')).toBe('low');
    expect(parseSessionSubstance('real')).toBe('real');
    expect(parseSessionSubstance('bogus')).toBeUndefined();
    expect(parseSessionSubstance(undefined)).toBeUndefined();
  });
});

describe('aggregateSubstance', () => {
  it('picks max over batches: real > low > none', () => {
    expect(aggregateSubstance(['none', 'low'])).toBe('low');
    expect(aggregateSubstance(['none', 'real', 'low'])).toBe('real');
    expect(aggregateSubstance(['none'])).toBe('none');
    expect(aggregateSubstance([undefined, undefined])).toBeUndefined();
  });
});
