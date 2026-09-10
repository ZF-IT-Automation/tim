// TIM Store — FTS5 query sanitization tests (Plan 1, Task 3)
//
// Strategy: each whitespace-separated token is emitted as an FTS5 quoted
// string ("token"). Operators (AND/OR/NOT/NEAR) and punctuation (`. / @
// + % # -`) become literal inside quotes. Real column filters
// (title/content/tags) survive as `column:"value"`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, sanitizeFtsQuery } from '../store.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('sanitizeFtsQuery (quoting strategy)', () => {
  it('quotes plain tokens', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('handles dots, slashes, plus, at, percent without crashing FTS5', () => {
    expect(sanitizeFtsQuery('store.ts')).toBe('"store.ts"');
    expect(sanitizeFtsQuery('src/store.ts')).toBe('"src/store.ts"');
    expect(sanitizeFtsQuery('C++')).toBe('"C++"');
    expect(sanitizeFtsQuery('user@example.com')).toBe('"user@example.com"');
    expect(sanitizeFtsQuery('100%')).toBe('"100%"');
  });

  it('keeps real column filters, quotes the value', () => {
    expect(sanitizeFtsQuery('title:fix')).toBe('title:"fix"');
    expect(sanitizeFtsQuery('content:store.ts')).toBe('content:"store.ts"');
  });

  it('splits bogus column filters into two terms', () => {
    expect(sanitizeFtsQuery('kind:summary')).toBe('"kind" "summary"');
    expect(sanitizeFtsQuery('task:true')).toBe('"task" "true"');
  });

  it('promotes uppercase AND to FTS intersection; lowercase or stays literal', () => {
    expect(sanitizeFtsQuery('foo AND bar')).toBe('"foo" AND "bar"');
    expect(sanitizeFtsQuery('or')).toBe('"or"');
    expect(sanitizeFtsQuery('notes or tasks')).toBe('"notes" "or" "tasks"');
    expect(sanitizeFtsQuery('foo OR bar')).toBe('"foo" "OR" "bar"');
    expect(sanitizeFtsQuery('foo NOT bar')).toBe('"foo" "NOT" "bar"');
  });

  it('preserves double-quoted phrases as a single FTS term', () => {
    expect(sanitizeFtsQuery('"hello world"')).toBe('"hello world"');
    expect(sanitizeFtsQuery('say "hello world" now')).toBe('"say" "hello world" "now"');
  });

  it('or-terms mode keeps generated prompt OR recall', () => {
    expect(sanitizeFtsQuery('"fix" OR "sqlite" OR "wal"', 'or-terms'))
      .toBe('"fix" OR "sqlite" OR "wal"');
  });

  it('strips embedded double quotes', () => {
    expect(sanitizeFtsQuery('say "hello"')).toBe('"say" "hello"');
  });

  it('drops tokens with no alphanumeric content, returns empty for pure noise', () => {
    expect(sanitizeFtsQuery('--- *** ^^')).toBe('');
    expect(sanitizeFtsQuery('')).toBe('');
  });
});

describe('searchFts resilience (quoting strategy)', () => {
  beforeEach(async () => {
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
    const results = await store.searchFts('foo AND bar', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('does not crash on column-filter notation (task:true)', async () => {
    const results = await store.searchFts('task:true', 10);
    expect(Array.isArray(results)).toBe(true);
    const good = await store.searchFts('task notes', 10);
    expect(good.length).toBeGreaterThan(0);
    expect(good.map(r => r.title)).toContain('Task management notes');
  });

  it('does not crash on NEAR / OR / NOT operators', async () => {
    await expect(store.searchFts('foo NEAR bar', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo OR bar', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo NOT bar', 10)).resolves.toBeDefined();
  });

  it('does not crash on FTS5 column name in query (kind:summary)', async () => {
    const results = await store.searchFts('kind:summary', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('does not crash on quoted / parenthesized / caret queries', async () => {
    await expect(store.searchFts('"hello"', 10)).resolves.toBeDefined();
    await expect(store.searchFts('(foo)', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo^bar', 10)).resolves.toBeDefined();
  });

  it('does not crash on everyday tokens with dots, slashes, @, %, +', async () => {
    // Regression: pre-fix these all threw "fts5: syntax error"
    await expect(store.searchFts('store.ts', 10)).resolves.toBeDefined();
    await expect(store.searchFts('src/store.ts', 10)).resolves.toBeDefined();
    await expect(store.searchFts('user@example.com', 10)).resolves.toBeDefined();
    await expect(store.searchFts('100%', 10)).resolves.toBeDefined();
    await expect(store.searchFts('C++', 10)).resolves.toBeDefined();
  });

  it('end-to-end: searching store.ts returns an entry that contains the literal', async () => {
    await store.write('A note about store.ts\nWe refactored the store implementation today.');
    const results = await store.searchFts('store.ts', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(r => r.title)).toContain('A note about store.ts');
  });

  it('returns matching entries for a sanitized multi-token query', async () => {
    const results = await store.searchFts('task management', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Task management notes');
  });

  it('uppercase AND intersects tokens in user queries', async () => {
    await store.write('Task management notes\nA list of tasks for the project.', {
      tags: ['#task', '#note'],
    });
    const results = await store.searchFts('task AND management', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Task management notes');
  });

  it('AndNeedle AND bravo finds intersection (reviewer F3 repro)', async () => {
    await store.write('AndNeedle alpha bravo\nContent with both tokens.', {
      tags: ['#note'],
    });
    const results = await store.searchFts('AndNeedle AND bravo', 10);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('AndNeedle alpha bravo');
  });

  it('returns empty array for pure-operator / empty input (not crash)', async () => {
    expect(await store.searchFts('', 10)).toEqual([]);
    // "AND OR NOT" no longer becomes empty — tokens are quoted literals.
    // Each token (AND, OR, NOT) survives as a quoted literal; if no doc
    // contains those words, result is empty.
    expect(await store.searchFts('   ', 10)).toEqual([]);
  });

  it('does not error on lone function words or trailing operators', async () => {
    await expect(store.searchFts('or', 10)).resolves.toBeDefined();
    await expect(store.searchFts('and', 10)).resolves.toBeDefined();
    await expect(store.searchFts('foo or', 10)).resolves.toBeDefined();
  });

  it('or-terms mode finds prompt recall hits without requiring every term', async () => {
    await store.write('German recall\nDie Wal-Größe für sqlite muss kleiner werden.', {
      tags: ['#note'],
    });
    const results = await store.searchFts(
      '"wal" OR "größe" OR "sqlite" OR "optimieren"',
      10,
      { ftsQueryMode: 'or-terms' },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('German recall');
  });
});