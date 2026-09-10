import { describe, it, expect } from 'vitest';
import {
  buildAgentDerivedSessionEvidence,
  legacyEvidenceDefaults,
  mergeImportEvidence,
  validateEvidenceMetadata,
  assertValidEvidenceMetadata,
} from '../evidence.js';

describe('evidence metadata validation', () => {
  it('accepts a well-formed evidence object', () => {
    const result = validateEvidenceMetadata({
      authority: 'user_asserted',
      sources: [
        { kind: 'entry', entryId: '01JABCDEFGHJKMNPQRSTVWXYZ0' },
        { kind: 'session', sessionId: 'sess-1', seqFrom: 1, seqTo: 3 },
        { kind: 'git', revision: 'abc1234', path: 'README.md' },
        { kind: 'document', uri: 'https://example.com/spec' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed session bounds', () => {
    const result = validateEvidenceMetadata({
      authority: 'agent_derived',
      sources: [{ kind: 'session', sessionId: 's', seqFrom: 5, seqTo: 2 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('seqFrom'))).toBe(true);
    }
  });

  it('rejects oversized source arrays', () => {
    const sources = Array.from({ length: 33 }, (_, i) => ({
      kind: 'document' as const,
      uri: `https://example.com/${i}`,
    }));
    const result = validateEvidenceMetadata({ authority: 'imported', sources });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown keys consistently without mutating the caller', () => {
    const metadata = { evidence: { authority: 'user_asserted', sources: [], confidence: 0.9 } };
    const before = structuredClone(metadata);
    expect(() => assertValidEvidenceMetadata(metadata)).toThrow(/unknown fields/);
    expect(metadata).toEqual(before);
    expect(validateEvidenceMetadata({
      authority: 'user_asserted',
      sources: [{ kind: 'document', uri: 'https://example.com/spec', note: 'page 7' }],
    }).ok).toBe(false);
  });

  it('legacy defaults are unknown authority with no sources', () => {
    expect(legacyEvidenceDefaults()).toEqual({ authority: 'unknown', sources: [] });
  });

  it('mergeImportEvidence preserves stronger existing authority', () => {
    const merged = mergeImportEvidence(
      { authority: 'user_asserted', sources: [] },
      { authority: 'imported', sources: [] },
    );
    expect(merged.authority).toBe('user_asserted');
  });

  it('buildAgentDerivedSessionEvidence stamps session source', () => {
    expect(buildAgentDerivedSessionEvidence('sess', 2, 7)).toEqual({
      authority: 'agent_derived',
      sources: [{ kind: 'session', sessionId: 'sess', seqFrom: 2, seqTo: 7 }],
    });
  });
});
