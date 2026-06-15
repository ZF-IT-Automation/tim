// Tests for tim-core MetadataType helpers
import { describe, it, expect } from 'vitest';
import {
  isMetadataType,
  isBuiltinMetadataType,
  normalizeLegacyTypeTag,
  METADATA_TYPES,
  BUILTIN_METADATA_TYPES,
  LEGACY_METADATA_TYPES,
} from '../index.js';

describe('BUILTIN_METADATA_TYPES', () => {
  it('exposes 14 built-in schema v3 types', () => {
    expect(BUILTIN_METADATA_TYPES).toHaveLength(14);
    expect(METADATA_TYPES).toEqual(BUILTIN_METADATA_TYPES);
    expect(BUILTIN_METADATA_TYPES).toContain('task');
    expect(BUILTIN_METADATA_TYPES).toContain('project');
    expect(BUILTIN_METADATA_TYPES).toContain('session');
    expect(BUILTIN_METADATA_TYPES).toContain('batch_summary');
    expect(BUILTIN_METADATA_TYPES).toContain('exchange');
    expect(BUILTIN_METADATA_TYPES).toContain('event');
  });

  it('keeps legacy phase-0 types separate', () => {
    expect(LEGACY_METADATA_TYPES).toEqual(['rule', 'human']);
    expect(BUILTIN_METADATA_TYPES).not.toContain('rule');
    expect(BUILTIN_METADATA_TYPES).not.toContain('human');
  });
});

describe('isMetadataType', () => {
  it('recognizes builtin types', () => {
    expect(isMetadataType('task')).toBe(true);
    expect(isMetadataType('project')).toBe(true);
    expect(isMetadataType('batch_summary')).toBe(true);
  });

  it('recognizes legacy phase-0 types', () => {
    expect(isMetadataType('rule')).toBe(true);
    expect(isMetadataType('human')).toBe(true);
  });

  it('rejects invalid types', () => {
    expect(isMetadataType('knowledge')).toBe(false);
    expect(isMetadataType('checkpoint')).toBe(false);
    expect(isMetadataType('')).toBe(false);
    expect(isMetadataType(null)).toBe(false);
    expect(isMetadataType(undefined)).toBe(false);
    expect(isMetadataType(42)).toBe(false);
    expect(isMetadataType({})).toBe(false);
  });

  it('recognizes every BUILTIN_METADATA_TYPES member', () => {
    for (const t of BUILTIN_METADATA_TYPES) {
      expect(isBuiltinMetadataType(t)).toBe(true);
      expect(isMetadataType(t)).toBe(true);
    }
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

  it('normalizes "#RULE" hash+uppercase', () => {
    expect(normalizeLegacyTypeTag('#RULE')).toBe('rule');
  });

  it('handles leading/trailing whitespace', () => {
    expect(normalizeLegacyTypeTag('  #rule  ')).toBe('rule');
    expect(normalizeLegacyTypeTag('\t#human\n')).toBe('human');
  });

  it('returns null for non-legacy tags', () => {
    expect(normalizeLegacyTypeTag('task')).toBeNull();
    expect(normalizeLegacyTypeTag('#session-summary')).toBeNull();
    expect(normalizeLegacyTypeTag('#batch-summary')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(normalizeLegacyTypeTag(null)).toBeNull();
    expect(normalizeLegacyTypeTag(undefined)).toBeNull();
    expect(normalizeLegacyTypeTag('')).toBeNull();
  });
});
