"use strict";
// TIM Store — FTS5 query sanitization tests (BUG 1)
// Regression tests: searchFts must not crash on FTS5 operators or column-filter notation.
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const store_js_1 = require("../store.js");
let store;
(0, vitest_1.beforeEach)(() => {
    store = new store_js_1.TimStore(':memory:');
});
(0, vitest_1.afterEach)(() => {
    store.close();
});
(0, vitest_1.describe)('sanitizeFtsQuery (BUG 1)', () => {
    (0, vitest_1.it)('strips FTS5 operator words (AND, OR, NOT, NEAR) case-insensitive', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo AND bar')).toBe('foo bar');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo and bar')).toBe('foo bar');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo OR bar')).toBe('foo bar');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo NOT bar')).toBe('foo bar');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo NEAR bar')).toBe('foo bar');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('AND OR NOT NEAR')).toBe(''); // all stripped
    });
    (0, vitest_1.it)('escapes column-filter colon (task:true → task true)', () => {
        // This is the BUG 1 crash: FTS5 parses "task:true" as column filter.
        // Sanitized result must NOT contain a colon.
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('task:true')).toBe('task true');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('kind:summary')).toBe('kind summary');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('a:1')).toBe('a 1');
        // tag:#important → colon becomes space, # is allowed in tokens, FTS5 tokenizes it as 'tag' + 'important'
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('tag:#important')).toBe('tag #important');
    });
    (0, vitest_1.it)('strips special chars that break FTS5 tokenization', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('"hello"')).toBe('hello');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('(foo)')).toBe('foo');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo*')).toBe('foo');
        // ^ is stripped (space), so "foo^bar" becomes two safe tokens
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo^bar')).toBe('foo bar');
        // Apostrophe stripped → "don" and "t" (space-separated, both safe tokens)
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)("don't")).toBe('don t');
    });
    (0, vitest_1.it)('handles empty / whitespace-only / operator-only inputs', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('')).toBe('');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('   ')).toBe('');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('AND')).toBe('');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('   AND OR   ')).toBe('');
    });
    (0, vitest_1.it)('preserves legitimate FTS5 column filters (title:Doc passes through)', () => {
        // title/content/tags are the real FTS5 column names — these colons
        // must be preserved so the column-filter still works.
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('title:Doc')).toBe('title:Doc');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('content:hello')).toBe('content:hello');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('tags:important')).toBe('tags:important');
    });
    (0, vitest_1.it)('strips bogus "column" filters but keeps the words as tokens', () => {
        // kind/summary/task/a are NOT real FTS5 columns — sanitizer must
        // split them into two safe tokens.
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('kind:summary')).toBe('kind summary');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('task:true')).toBe('task true');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('a:1')).toBe('a 1');
    });
});
(0, vitest_1.describe)('searchFts resilience (BUG 1)', () => {
    // Seed entries so we can prove the search returns results, not just "no crash".
    (0, vitest_1.beforeEach)(async () => {
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
    (0, vitest_1.it)('does not crash on FTS5 operator words in query', async () => {
        // "foo AND bar" used to crash. Now: AND stripped, search runs on tokens.
        const results = await store.searchFts('foo AND bar', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on column-filter notation (task:true)', async () => {
        // This was the BUG 1 crash: "no such column: task".
        // Sanitized to "task true" — but "true" isn't in our seed docs, so this
        // returns 0 results. What matters: no crash, no "no such column" error.
        // Use the "AND" form (BUG 1.1) where BOTH tokens exist in the doc:
        const results = await store.searchFts('task:true', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
        // 0 results is fine — the bug was the crash, not empty results.
        // Verify a no-crash with a known-good multi-token sanitized query:
        const good = await store.searchFts('task AND notes', 10);
        (0, vitest_1.expect)(good.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(good.map(r => r.title)).toContain('Task management notes');
    });
    (0, vitest_1.it)('does not crash on NEAR / OR / NOT operators', async () => {
        await (0, vitest_1.expect)(store.searchFts('foo NEAR bar', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('foo OR bar', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('foo NOT bar', 10)).resolves.toBeDefined();
    });
    (0, vitest_1.it)('does not crash on FTS5 column name in query (kind:summary)', async () => {
        // "kind:summary" triggers "no such column: kind" pre-fix.
        // Sanitized to "kind summary" → both tokens searched literally.
        const results = await store.searchFts('kind:summary', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on quoted / parenthesized / caret queries', async () => {
        await (0, vitest_1.expect)(store.searchFts('"hello"', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('(foo)', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('foo^bar', 10)).resolves.toBeDefined();
    });
    (0, vitest_1.it)('returns matching entries for a sanitized multi-token query', async () => {
        // "task AND management" → sanitized to "task management" → matches entry #1.
        const results = await store.searchFts('task AND management', 10);
        (0, vitest_1.expect)(results.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(results[0].title).toBe('Task management notes');
    });
    (0, vitest_1.it)('returns empty array for pure-operator / empty input (not crash)', async () => {
        (0, vitest_1.expect)(await store.searchFts('', 10)).toEqual([]);
        (0, vitest_1.expect)(await store.searchFts('AND OR NOT', 10)).toEqual([]);
        (0, vitest_1.expect)(await store.searchFts('   ', 10)).toEqual([]);
    });
});
//# sourceMappingURL=search-sanitization.test.js.map