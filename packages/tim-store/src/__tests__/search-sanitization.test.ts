// TIM Store — FTS5 query sanitization tests (BUG 1)
// Regression tests: searchFts must not crash on FTS5 operators or column-filter notation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, sanitizeFtsQuery } from '../store.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('sanitizeFtsQuery (BUG 1)', () => {
  it('strips FTS5 operator words (AND, OR, NOT, NEAR) case-insensitive', () => {
    expect(sanitizeFtsQuery('foo AND bar')).toBe('foo bar');
    expect(sanitizeFtsQuery('foo and bar')).toBe('foo bar');
    expect(sanitizeFtsQuery('foo OR bar')).toBe('foo bar');
    expect(sanitizeFtsQuery('foo NOT bar')).toBe('foo bar');
    expect(sanitizeFtsQuery('foo NEAR bar')).toBe('foo bar');
    expect(sanitizeFtsQuery('AND OR NOT NEAR')).toBe(''); // all stripped
  });

  it('escapes column-filter colon (task:true → task true)', () => {
    // This is the BUG 1 crash: FTS5 parses "task:true" as column filter.
    // Sanitized result must NOT contain a colon.
    expect(sanitizeFtsQuery('task:true')).toBe('task true');
    expect(sanitizeFtsQuery('kind:summary')).toBe('kind summary');
    expect(sanitizeFtsQuery('a:1')).toBe('a 1');
    // tag:#important → colon becomes space, # is allowed in tokens, FTS5 tokenizes it as 'tag' + 'important'
    expect(sanitizeFtsQuery('tag:#important')).toBe('tag #important');
  });

  it('strips special chars that break FTS5 tokenization', () => {
    expect(sanitizeFtsQuery('"hello"')).toBe('hello');
    expect(sanitizeFtsQuery('(foo)')).toBe('foo');
    expect(sanitizeFtsQuery('foo*')).toBe('foo');
    // ^ is stripped (space), so "foo^bar" becomes two safe tokens
    expect(sanitizeFtsQuery('foo^bar')).toBe('foo bar');
    // Apostrophe stripped → "don" and "t" (space-separated, both safe tokens)
    expect(sanitizeFtsQuery("don't")).toBe('don t');
  });

  it('handles empty / whitespace-only / operator-only inputs', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('AND')).toBe('');
    expect(sanitizeFtsQuery('   AND OR   ')).toBe('');
  });

  it('preserves alphanumeric tokens and joins with implicit AND', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('hello world');
    expect(sanitizeFtsQuery('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeFtsQuery('foo123 bar456')).toBe('foo123 bar456');
  });
});

describe('searchFts resilience (BUG 1)', () => {
  // Seed entries so we can prove the search returns results, not just "no crash".
  beforeEach(async () => {
    // store.write(title, opts) — content goes via the \n separator in the title arg
    // OR via update(). Use the \n form to seed title+content in one call.
    await store.write('Task management notes\nA list of tasks for the project.', {
      tags: ['#task', '#note'],
    });
    await store.write('Programming patterns\nCommon patterns for async task execution.', {
      tags: ['#programming'],
    });
    await store.write('Summary doc\nThis entry discusses the kind of content we store.', {
      tags: ['#summary'],
    });
  });

  it('does not crash on FTS5 operator words in query', async () => {
    // "foo AND bar" used to crash. Now: AND stripped, search runs on tokens.
    const results = await store.searchFts('foo AND bar', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('does not crash on column-filter notation (task:true)', async () => {
    // This was the BUG 1 crash: "no such column: task".
    // Sanitized to "task true" — but "true" isn't in our seed docs, so this
    // returns 0 results. What matters: no crash, no "no such column" error.
    // Use the "AND" form (BUG 1.1) where BOTH tokens exist in the doc:
    const results = await store.searchFts('task:true', 10);
    expect(Array.isArray(results)).toBe(true);
    // 0 results is fine — the bug was the crash, not empty results.
    // Verify a no-crash with a known-good multi-token sanitized query:
    const good = await store.searchFts('task AND notes', 10);
    expect(good.length).toBeGreaterThan(0);
    expect(good.map(r => r.title)).toContain('Task management notes');
  });

  it('does not crash on NEAR / OR / NOT operators', async () => {
    await expect(store.searchFts('foo NEAR bar', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo OR bar', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo NOT bar', 10)).resolves.toBeDefined();
  });

  it('does not crash on FTS5 column name in query (kind:summary)', async () => {
    // "kind:summary" triggers "no such column: kind" pre-fix.
    // Sanitized to "kind summary" → both tokens searched literally.
    const results = await store.searchFts('kind:summary', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('does not crash on quoted / parenthesized / caret queries', async () => {
    await expect(store.searchFts('"hello"', 10)).resolves.toBeDefined();
    await expect(store.searchFts('(foo)', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo^bar', 10)).resolves.toBeDefined();
  });

  it('returns matching entries for a sanitized multi-token query', async () => {
    // "task AND management" → sanitized to "task management" → matches entry #1.
    const results = await store.searchFts('task AND management', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Task management notes');
  });

  it('returns empty array for pure-operator / empty input (not crash)', async () => {
    expect(await store.searchFts('', 10)).toEqual([]);
    expect(await store.searchFts('AND OR NOT', 10)).toEqual([]);
    expect(await store.searchFts('   ', 10)).toEqual([]);
  });
});
