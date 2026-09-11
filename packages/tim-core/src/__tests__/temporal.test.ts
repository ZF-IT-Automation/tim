import { describe, it, expect } from 'vitest';
import {
  temporalEligibilityAt,
  validateCallerTemporalMetadata,
  parseTemporalMetadata,
  isTimezoneQualifiedIso,
  normalizeIsoTimestamp,
  isoTimestampToEpochMs,
  mergeCallerTemporalMetadata,
  rejectTemporalManagedFieldClearing,
} from '../temporal.js';

describe('temporal metadata validation', () => {
  it('accepts half-open validity interval and normalizes to canonical UTC', () => {
    const result = validateCallerTemporalMetadata({
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-06-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.temporal.validFrom).toBe('2026-01-01T00:00:00.000Z');
      expect(result.temporal.validUntil).toBe('2026-06-01T00:00:00.000Z');
    }
  });

  it('rejects reversed intervals', () => {
    const result = validateCallerTemporalMetadata({
      validFrom: '2026-06-01T00:00:00Z',
      validUntil: '2026-01-01T00:00:00Z',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects system-managed supersession fields on direct writes', () => {
    const result = validateCallerTemporalMetadata({
      validFrom: '2026-01-01T00:00:00Z',
      supersededAt: '2026-03-01T00:00:00Z',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects timestamps without timezone', () => {
    expect(isTimezoneQualifiedIso('2026-01-01T00:00:00')).toBe(false);
    const result = validateCallerTemporalMetadata({ validFrom: '2026-01-01T00:00:00' });
    expect(result.ok).toBe(false);
  });

  it('rejects impossible calendar dates and invalid clock times', () => {
    expect(isTimezoneQualifiedIso('2026-02-31T00:00:00Z')).toBe(false);
    expect(isTimezoneQualifiedIso('2026-01-01T24:01:00Z')).toBe(false);
    expect(isTimezoneQualifiedIso('2026-01-01T00:00:00+25:00')).toBe(false);
    expect(isTimezoneQualifiedIso('2026-01-01T00:00:00.1234Z')).toBe(false);
  });

  it('treats equivalent instants with different offset and fraction forms as equal epochs', () => {
    const z = '2026-03-15T12:00:00Z';
    const millis = '2026-03-15T12:00:00.000Z';
    const offset = '2026-03-15T14:00:00+02:00';
    expect(isoTimestampToEpochMs(z)).toBe(isoTimestampToEpochMs(millis));
    expect(isoTimestampToEpochMs(z)).toBe(isoTimestampToEpochMs(offset));
    expect(normalizeIsoTimestamp(offset)).toBe('2026-03-15T12:00:00.000Z');
  });

  it('validates offset bounds independently of Date.parse and preserves early ISO years', () => {
    expect(isTimezoneQualifiedIso('2026-01-01T00:00:00+14:01')).toBe(false);
    expect(isTimezoneQualifiedIso('2026-01-01T00:00:00-15:00')).toBe(false);
    expect(isTimezoneQualifiedIso('2026-01-01T00:00:00+14:00')).toBe(true);
    expect(normalizeIsoTimestamp('0099-01-01T00:00:00Z')).toBe('0099-01-01T00:00:00.000Z');
  });
});

describe('parseTemporalMetadata', () => {
  it('preserves supersededBy entry IDs instead of treating them as timestamps', () => {
    const parsed = parseTemporalMetadata({
      validFrom: '2026-01-01T00:00:00Z',
      supersededAt: '2026-03-01T00:00:00Z',
      supersededBy: '01JABCDEF012345678901234567',
    });
    expect(parsed?.supersededBy).toBe('01JABCDEF012345678901234567');
    expect(parsed?.supersededAt).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('managed temporal merge', () => {
  it('preserves supersession fields when caller patches validity only', () => {
    const existing = {
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-06-01T00:00:00.000Z',
      supersededAt: '2026-03-15T12:00:00.000Z',
      supersededBy: '01JABCDEF012345678901234567',
    };
    const merged = mergeCallerTemporalMetadata(existing, {
      validUntil: '2026-05-01T00:00:00.000Z',
    });
    expect(merged.supersededAt).toBe(existing.supersededAt);
    expect(merged.supersededBy).toBe(existing.supersededBy);
    expect(merged.validUntil).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rejects empty temporal patches that would clear supersession state', () => {
    expect(() => rejectTemporalManagedFieldClearing(
      { temporal: { supersededAt: '2026-03-15T12:00:00.000Z', supersededBy: '01JABC' } },
      { temporal: {} },
    )).toThrow(/cannot clear supersession state/);
  });
});

describe('temporal eligibility', () => {
  const temporal = parseTemporalMetadata({
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2026-06-01T00:00:00Z',
    supersededAt: '2026-05-01T00:00:00Z',
  })!;

  it('is not yet valid before validFrom', () => {
    const { eligible, state } = temporalEligibilityAt(
      temporal,
      new Date('2025-12-31T23:59:59Z'),
    );
    expect(eligible).toBe(false);
    expect(state).toBe('not_yet_valid');
  });

  it('is current inside the open interval before supersession', () => {
    const { eligible, state } = temporalEligibilityAt(
      temporal,
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(eligible).toBe(true);
    expect(state).toBe('current');
  });

  it('is superseded at and after supersededAt', () => {
    const atBoundary = temporalEligibilityAt(temporal, new Date('2026-05-01T00:00:00Z'));
    expect(atBoundary.eligible).toBe(false);
    expect(atBoundary.state).toBe('superseded');
  });

  it('treats validUntil as exclusive', () => {
    const intervalOnly = parseTemporalMetadata({
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-06-01T00:00:00Z',
    })!;
    const { eligible, state } = temporalEligibilityAt(
      intervalOnly,
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(eligible).toBe(false);
    expect(state).toBe('expired');
  });

  it('treats legacy rows without temporal as current', () => {
    const { eligible, state } = temporalEligibilityAt(undefined, new Date());
    expect(eligible).toBe(true);
    expect(state).toBe('current');
  });
});
