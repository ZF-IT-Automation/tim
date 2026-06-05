"use strict";
// TIM Store — FTS5 schema regression tests (BUG 3)
// BUG 3 reported: queries with "summary:foo" / "kind:bar" crash with
// "no such column: summary" / "no such column: kind".
//
// Root cause: FTS5 virtual table columns are `title, content, tags`.
// When a user query contains ANY `word:value` pattern where `word`
// doesn't match one of those three column names, FTS5 throws.
//
// The fix lives in sanitizeFtsQuery() (BUG 1): stripping colons prevents
// the user-supplied token from being parsed as a column filter at all.
// These tests pin that contract — if a future refactor reintroduces a
// raw query path, these tests will fail.
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
(0, vitest_1.describe)('FTS5 column-name resilience (BUG 3)', () => {
    // Seed an entry that contains the literal words "summary" and "kind" in
    // its content, so a raw `summary:foo` query would have looked "sensible"
    // to a human but still crashed FTS5 (because `summary` is not a column).
    (0, vitest_1.beforeEach)(async () => {
        await store.write('Doc about kind and summary\nThis content discusses the kind of summary we want.', {
            tags: ['#summary'],
        });
    });
    (0, vitest_1.it)('does not crash on a query referencing a non-column name "summary:foo"', async () => {
        // Pre-fix this threw: "no such column: summary"
        const results = await store.searchFts('summary:foo', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on a query referencing a non-column name "kind:summary"', async () => {
        const results = await store.searchFts('kind:summary', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on a query referencing a non-column name "task:true"', async () => {
        const results = await store.searchFts('task:true', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on chained column-filter notation "kind:summary:foo"', async () => {
        const results = await store.searchFts('kind:summary:foo', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('does not crash on a column-filter with empty value "summary:"', async () => {
        const results = await store.searchFts('summary:', 10);
        (0, vitest_1.expect)(Array.isArray(results)).toBe(true);
    });
    (0, vitest_1.it)('still allows valid FTS5 column filters (title:Doc, tags:summary) to work', async () => {
        // Sanity check: the sanitizer doesn't break legitimate column-filter
        // usage against REAL FTS5 columns (title, content, tags).
        // After sanitization "title:Doc" → "title Doc" — both must be in the doc.
        // The seeded entry title is "Doc about kind and summary" so both tokens
        // ARE present.
        const byTitle = await store.searchFts('title:Doc', 10);
        (0, vitest_1.expect)(byTitle.length).toBeGreaterThan(0);
        // "tags:summary" → "tags summary" — tags column has "summary", and
        // "summary" appears in the title too.
        const byTags = await store.searchFts('tags:summary', 10);
        (0, vitest_1.expect)(byTags.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('does not affect the real FTS5 columns (title, content, tags) schema', async () => {
        // Confirm the FTS5 table still has the three documented columns.
        // If a future migration renames them, the sanitizer would no longer
        // be the safety net — these tests should fail first.
        const tableInfo = store.getDb()
            .prepare("PRAGMA table_info(fts_entries)")
            .all();
        const columnNames = tableInfo.map((c) => c.name);
        (0, vitest_1.expect)(columnNames).toContain('title');
        (0, vitest_1.expect)(columnNames).toContain('content');
        (0, vitest_1.expect)(columnNames).toContain('tags');
        // The FTS5 rowid column is implicit and not in PRAGMA table_info.
    });
});
//# sourceMappingURL=fts-schema.test.js.map