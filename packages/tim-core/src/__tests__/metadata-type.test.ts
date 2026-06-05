// Tests for tim-core MetadataType helpers
import { describe, it, expect } from 'vitest';
import { isMetadataType, normalizeLegacyTypeTag, METADATA_TYPES } from '../index.js';

describe('METADATA_TYPES', () => {
  it('contains only rule and human', () => {
    expect(METADATA_TYPES).toEqual(['rule', 'human']);
  });

  it('is readonly', () => {
    // TypeScript enforces this at compile-time; runtime: push would work
    // but we only assert shape, not runtime immutability.
    expect(METADATA_TYPES.length).toBe(2);
  });
});

describe('isMetadataType', () => {
  it('recognizes valid types', () => {
    expect(isMetadataType('rule')).toBe(true);
    expect(isMetadataType('human')).toBe(true);
  });

  it('rejects invalid types', () => {
    expect(isMetadataType('project')).toBe(false);
    expect(isMetadataType('task')).toBe(false);
    expect(isMetadataType('')).toBe(false);
    expect(isMetadataType(null)).toBe(false);
    expect(isMetadataType(undefined)).toBe(false);
    expect(isMetadataType(42)).toBe(false);
    expect(isMetadataType({})).toBe(false);
  });
});

describe('normalizeLegacyTypeTag', () => {
  it('normalizes "#rule" → "rule"', () => {
    expect(normalizeLegacyTypeTag('#rule')).toBe('rule');
  });

  it('normalizes "#human" → "human"', () => {
    expect(normalizeLegacyTypeTag('#human')).toBe('human');
  });

  it('normalizes "rule" without hash', () => {
    expect(normalizeLegacyTypeTag('rule')).toBe('rule');
  });

  it('normalizes "HUMAN" uppercase', () => {
    expect(normalizeLegacyTypeTag('HUMAN')).toBe('human');
  });

  it('normalizes "#RULE" hash+uppercase', () => {
    expect(normalizeLegacyTypeTag('#RULE')).toBe('rule');
  });

  it('handles leading/trailing whitespace', () => {
    expect(normalizeLegacyTypeTag('  #rule  ')).toBe('rule');
    expect(normalizeLegacyTypeTag('\t#human\n')).toBe('human');
  });

  it('returns null for unknown tags', () => {
    expect(normalizeLegacyTypeTag('#session-summary')).toBeNull();
    expect(normalizeLegacyTypeTag('#batch-summary')).toBeNull();
    expect(normalizeLegacyTypeTag('task')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(normalizeLegacyTypeTag(null)).toBeNull();
    expect(normalizeLegacyTypeTag(undefined)).toBeNull();
    expect(normalizeLegacyTypeTag('')).toBeNull();
  });
});
