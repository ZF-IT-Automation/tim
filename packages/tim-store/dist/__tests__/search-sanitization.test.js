"use strict";
// TIM Store — FTS5 query sanitization tests (Plan 1, Task 3)
//
// Strategy: each whitespace-separated token is emitted as an FTS5 quoted
// string ("token"). Operators (AND/OR/NOT/NEAR) and punctuation (`. / @
// + % # -`) become literal inside quotes. Real column filters
// (title/content/tags) survive as `column:"value"`.
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
(0, vitest_1.describe)('sanitizeFtsQuery (quoting strategy)', () => {
    (0, vitest_1.it)('quotes plain tokens', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('hello world')).toBe('"hello" "world"');
    });
    (0, vitest_1.it)('handles dots, slashes, plus, at, percent without crashing FTS5', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('store.ts')).toBe('"store.ts"');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('src/store.ts')).toBe('"src/store.ts"');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('C++')).toBe('"C++"');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('user@example.com')).toBe('"user@example.com"');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('100%')).toBe('"100%"');
    });
    (0, vitest_1.it)('keeps real column filters, quotes the value', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('title:fix')).toBe('title:"fix"');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('content:store.ts')).toBe('content:"store.ts"');
    });
    (0, vitest_1.it)('splits bogus column filters into two terms', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('kind:summary')).toBe('"kind" "summary"');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('task:true')).toBe('"task" "true"');
    });
    (0, vitest_1.it)('treats operator words as literal terms (quoted)', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('foo AND bar')).toBe('"foo" "AND" "bar"');
    });
    (0, vitest_1.it)('strips embedded double quotes', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('say "hello"')).toBe('"say" "hello"');
    });
    (0, vitest_1.it)('drops tokens with no alphanumeric content, returns empty for pure noise', () => {
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('--- *** ^^')).toBe('');
        (0, vitest_1.expect)((0, store_js_1.sanitizeFtsQuery)('')).toBe('');
    });
});
(0, vitest_1.describe)('searchFts resilience (quoting strategy)', () => {
    (0, vitest_1.beforeEach)(async () => {
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
        const results = await store.searchFts('foo AND bar', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on column-filter notation (task:true)', async () => {
        const results = await store.searchFts('task:true', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
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
        const results = await store.searchFts('kind:summary', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on quoted / parenthesized / caret queries', async () => {
        await (0, vitest_1.expect)(store.searchFts('"hello"', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('(foo)', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('foo^bar', 10)).resolves.toBeDefined();
    });
    (0, vitest_1.it)('does not crash on everyday tokens with dots, slashes, @, %, +', async () => {
        // Regression: pre-fix these all threw "fts5: syntax error"
        await (0, vitest_1.expect)(store.searchFts('store.ts', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('src/store.ts', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('user@example.com', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('100%', 10)).resolves.toBeDefined();
        await (0, vitest_1.expect)(store.searchFts('C++', 10)).resolves.toBeDefined();
    });
    (0, vitest_1.it)('end-to-end: searching store.ts returns an entry that contains the literal', async () => {
        await store.write('A note about store.ts\nWe refactored the store implementation today.');
        const results = await store.searchFts('store.ts', 10);
        (0, vitest_1.expect)(results.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(results.map(r => r.title)).toContain('A note about store.ts');
    });
    (0, vitest_1.it)('returns matching entries for a sanitized multi-token query', async () => {
        // "task AND management" → both tokens searched literally via quotes.
        const results = await store.searchFts('task AND management', 10);
        (0, vitest_1.expect)(results.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(results[0].title).toBe('Task management notes');
    });
    (0, vitest_1.it)('returns empty array for pure-operator / empty input (not crash)', async () => {
        (0, vitest_1.expect)(await store.searchFts('', 10)).toEqual([]);
        // "AND OR NOT" no longer becomes empty — tokens are quoted literals.
        // Each token (AND, OR, NOT) survives as a quoted literal; if no doc
        // contains those words, result is empty.
        (0, vitest_1.expect)(await store.searchFts('   ', 10)).toEqual([]);
    });
});
//# sourceMappingURL=search-sanitization.test.js.map