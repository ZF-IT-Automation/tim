"use strict";
// TimStore batch helpers — entryExistsBatch + getRecentBatchSummaries
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const store_js_1 = require("../store.js");
const session_js_1 = require("../session.js");
const session_tree_js_1 = require("../session-tree.js");
let store;
let sessions;
(0, vitest_1.beforeEach)(() => {
    store = new store_js_1.TimStore(':memory:');
    sessions = new session_js_1.SessionManager(store);
});
(0, vitest_1.afterEach)(() => {
    store.close();
});
async function seedBatchSummaries(count, projectId = 'P0200') {
    await store.createProject(projectId);
    for (let i = 1; i <= count; i++) {
        const sessionId = `sess-batch-${projectId}-${i}`;
        await sessions.startProjectSession({
            sessionId,
            projectId,
            agentName: 'test',
            cwd: '/',
            harness: 'vitest',
            batchSize: 2,
        });
        await sessions.logExchange(sessionId, [
            { role: 'user', content: `Q${i}` },
            { role: 'agent', content: `A${i}` },
        ]);
        await sessions.writeBatchSummary(sessionId, 1, `summary ${i}`, { seqFrom: 1, seqTo: 1 });
    }
}
(0, vitest_1.describe)('entryExistsBatch', () => {
    (0, vitest_1.it)('returns empty Set for empty input', async () => {
        const result = await store.entryExistsBatch([]);
        (0, vitest_1.expect)(result.size).toBe(0);
    });
    (0, vitest_1.it)('returns empty Set when no ids exist', async () => {
        const result = await store.entryExistsBatch(['nonexistent']);
        (0, vitest_1.expect)(result.size).toBe(0);
    });
    (0, vitest_1.it)('returns only existing id when mixed with nonexistent', async () => {
        const entry = await store.write('exists');
        const result = await store.entryExistsBatch([entry.id, 'nonexistent']);
        (0, vitest_1.expect)(result.size).toBe(1);
        (0, vitest_1.expect)(result.has(entry.id)).toBe(true);
    });
    (0, vitest_1.it)('returns Set of all existing ids from a larger batch', async () => {
        const e1 = await store.write('one');
        const e2 = await store.write('two');
        const result = await store.entryExistsBatch([e1.id, 'missing', e2.id, 'also-missing']);
        (0, vitest_1.expect)(result.size).toBe(2);
        (0, vitest_1.expect)(result.has(e1.id)).toBe(true);
        (0, vitest_1.expect)(result.has(e2.id)).toBe(true);
    });
});
(0, vitest_1.describe)('getRecentBatchSummaries', () => {
    (0, vitest_1.it)('returns at most limit entries with batch-summary kind and session-summary tag', async () => {
        await seedBatchSummaries(7);
        const results = await store.getRecentBatchSummaries({ limit: 5 });
        (0, vitest_1.expect)(results.length).toBeLessThanOrEqual(5);
        (0, vitest_1.expect)(results.length).toBe(5);
        for (const entry of results) {
            (0, vitest_1.expect)(entry.metadata.kind).toBe(session_tree_js_1.KIND_BATCH);
            (0, vitest_1.expect)(entry.tags).toContain('#session-summary');
        }
    });
    (0, vitest_1.it)('returns empty when maxAgeDays is 0', async () => {
        await seedBatchSummaries(3);
        const results = await store.getRecentBatchSummaries({ maxAgeDays: 0 });
        (0, vitest_1.expect)(results).toEqual([]);
    });
    (0, vitest_1.it)('filters by sessionId when provided', async () => {
        await seedBatchSummaries(3);
        const targetSession = 'sess-batch-P0200-2';
        const results = await store.getRecentBatchSummaries({ sessionId: targetSession, limit: 10 });
        (0, vitest_1.expect)(results.length).toBe(1);
        (0, vitest_1.expect)(results[0].metadata.sessionId).toBe(targetSession);
    });
    (0, vitest_1.it)('filters by project root when provided', async () => {
        await seedBatchSummaries(2, 'P0201');
        await seedBatchSummaries(2, 'P0202');
        const results = await store.getRecentBatchSummaries({ root: 'P0201', limit: 10 });
        (0, vitest_1.expect)(results.length).toBe(2);
        for (const entry of results) {
            (0, vitest_1.expect)(store.getProjectLabel(entry.id)).toBe('P0201');
        }
    });
});
//# sourceMappingURL=store-batch-helpers.test.js.map