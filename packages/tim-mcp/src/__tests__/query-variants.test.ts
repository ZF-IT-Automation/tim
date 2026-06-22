import { describe, it, expect } from 'vitest';
import {
  expandQueryVariants,
  lemmatize,
  fuzzyOne,
  dedupeById,
} from '../query-variants.js';

describe('expandQueryVariants', () => {
  it('returns at least 4 variants for Lockfile Bug', () => {
    const variants = expandQueryVariants('Lockfile Bug');
    expect(variants.length).toBeGreaterThanOrEqual(4);
  });

  it('includes lowercase variant for Lockfile Bug', () => {
    const variants = expandQueryVariants('Lockfile Bug');
    expect(variants).toContain('lockfile bug');
  });

  it('includes synonym-expanded bug variants', () => {
    const variants = expandQueryVariants('Lockfile Bug');
    const lower = variants.map((v) => v.toLowerCase());
    expect(lower.some((v) => v.includes('error'))).toBe(true);
    expect(lower.some((v) => v.includes('issue'))).toBe(true);
    expect(lower.some((v) => v.includes('defect'))).toBe(true);
    expect(lower.some((v) => v.includes('failure'))).toBe(true);
  });

  it('respects cap for nonsense input', () => {
    const variants = expandQueryVariants('xyz123nonsense');
    expect(variants.length).toBeLessThanOrEqual(12);
  });

  it('never returns more than 12 variants for pathological input', () => {
    const pathological =
      'lockfile bug worker telegram config mcp hook memory read write search error fix refactor feature test doc session';
    const variants = expandQueryVariants(pathological);
    expect(variants.length).toBeLessThanOrEqual(12);
  });
});

describe('lemmatize', () => {
  it('strips plural suffix from workers', () => {
    const result = lemmatize('workers');
    expect(result).toBe('work');
  });
});

describe('fuzzyOne', () => {
  it('includes single-char-deletion variants for lockfile', () => {
    const variants = fuzzyOne('lockfile');
    expect(variants).toContain('ockfile');
    expect(variants).toContain('lckfile');
  });
});

describe('dedupeById', () => {
  it('removes duplicate ids preserving order', () => {
    const items = [{ id: '1' }, { id: '1' }, { id: '2' }];
    expect(dedupeById(items)).toEqual([{ id: '1' }, { id: '2' }]);
  });
});
