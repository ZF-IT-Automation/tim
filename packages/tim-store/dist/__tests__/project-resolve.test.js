"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const store_js_1 = require("../store.js");
(0, vitest_1.describe)('resolveProjectLabel', () => {
    let store;
    (0, vitest_1.beforeEach)(() => {
        store = new store_js_1.TimStore(':memory:');
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.it)('resolves direct label', async () => {
        await store.createProject('P0048', { content: 'o9k project' });
        const r = await store.resolveProjectLabel('P0048');
        (0, vitest_1.expect)(r).toEqual({ status: 'found', label: 'P0048' });
    });
    (0, vitest_1.it)('resolves alias to project label', async () => {
        await store.createProject('P0048', { content: 'o9k', aliases: ['o9k', 'hmem'] });
        const r = await store.resolveProjectLabel('o9k');
        (0, vitest_1.expect)(r).toEqual({ status: 'found', label: 'P0048' });
    });
    (0, vitest_1.it)('alias lookup is case-insensitive', async () => {
        await store.createProject('P0048', { aliases: ['O9K'] });
        const r = await store.resolveProjectLabel('O9K');
        (0, vitest_1.expect)(r.status).toBe('found');
    });
    (0, vitest_1.it)('returns not_found for unknown query', async () => {
        const r = await store.resolveProjectLabel('nope');
        (0, vitest_1.expect)(r).toEqual({ status: 'not_found', query: 'nope' });
    });
    (0, vitest_1.it)('returns ambiguous when multiple projects share alias', async () => {
        await store.createProject('P0048', { aliases: ['shared'] });
        await store.createProject('P0099', { aliases: ['shared'] });
        const r = await store.resolveProjectLabel('shared');
        (0, vitest_1.expect)(r.status).toBe('ambiguous');
        if (r.status === 'ambiguous') {
            (0, vitest_1.expect)(r.labels).toEqual(['P0048', 'P0099']);
        }
    });
    (0, vitest_1.it)('loadProject loads via alias', async () => {
        await store.createProject('P0048', { content: 'body', aliases: ['o9k'] });
        const loaded = await store.loadProject('o9k');
        (0, vitest_1.expect)(loaded?.project.metadata.label).toBe('P0048');
    });
    (0, vitest_1.it)('search returns project by label when label is not in FTS corpus', async () => {
        await store.createProject('P0063', { content: 'body only, no P0063 in title' });
        const results = await store.search({ query: 'P0063' });
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0].metadata.label).toBe('P0063');
    });
    (0, vitest_1.it)('search returns project by alias', async () => {
        await store.createProject('P0048', { content: 'body', aliases: ['o9k'] });
        const results = await store.search({ query: 'o9k' });
        (0, vitest_1.expect)(results.some(e => e.metadata.label === 'P0048')).toBe(true);
    });
    (0, vitest_1.it)('search still finds content hits and does not duplicate label match', async () => {
        await store.createProject('P0063', { content: 'Infinite memory system' });
        const results = await store.search({ query: 'Infinite' });
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results.filter(e => e.metadata.label === 'P0063')).toHaveLength(1);
    });
    (0, vitest_1.it)('createProject rejects duplicate label', async () => {
        await store.createProject('P0001', { content: 'first' });
        await (0, vitest_1.expect)(store.createProject('P0001', { content: 'second' }))
            .rejects.toThrow(/Project label already exists/);
    });
    (0, vitest_1.it)('createProject allows same label after tombstone', async () => {
        const first = await store.createProject('P0001', { content: 'first' });
        await store.delete(first.id, true);
        const second = await store.createProject('P0001', { content: 'second' });
        (0, vitest_1.expect)(second.id).not.toBe(first.id);
        (0, vitest_1.expect)(second.metadata.label).toBe('P0001');
    });
});
//# sourceMappingURL=project-resolve.test.js.map