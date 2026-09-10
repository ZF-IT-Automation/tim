import { describe, it, expect } from 'vitest';
import {
  temporalEligibilityAt,
  validateCallerTemporalMetadata,
  parseTemporalMetadata,
  isTimezoneQualifiedIso,
} from '../temporal.js';

describe('temporal metadata validation', () => {
  it('accepts half-open validity interval', () => {
    const result = validateCallerTemporalMetadata({
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-06-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.temporal.validFrom).toBe('2026-01-01T00:00:00Z');
      expect(result.temporal.validUntil).toBe('2026-06-01T00:00:00Z');
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
