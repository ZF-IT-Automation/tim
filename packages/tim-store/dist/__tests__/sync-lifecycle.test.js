"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const index_js_1 = require("../index.js");
const sync_methods_js_1 = require("../sync-methods.js");
async function collectDescendants(store, rootId) {
    const result = [];
    async function walk(parentId) {
        const children = await store.getChildren(parentId);
        for (const child of children) {
            result.push(child);
            await walk(child.id);
        }
    }
    await walk(rootId);
    return result;
}
(0, vitest_1.describe)('sync lifecycle (F-STORE-002/004/005)', () => {
    let store;
    (0, vitest_1.afterEach)(() => {
        store?.close();
    });
    (0, vitest_1.it)('soft delete stages with irrelevant=1 (F-STORE-002)', async () => {
        store = new index_js_1.TimStore(':memory:');
        const entry = await store.write('hello world');
        (0, sync_methods_js_1.ackStaging)(store.getDb(), [entry.id]);
        await store.delete(entry.id, false);
        const unacked = (0, sync_methods_js_1.getUnackedStaging)(store.getDb());
        (0, vitest_1.expect)(unacked).toHaveLength(1);
        const payload = JSON.parse(unacked[0].payload);
        (0, vitest_1.expect)(payload.id).toBe(entry.id);
        (0, vitest_1.expect)(payload.irrelevant).toBe(1);
    });
    (0, vitest_1.it)('applyStaging with older timestamp is rejected (F-STORE-004)', async () => {
        store = new index_js_1.TimStore(':memory:');
        const entry = await store.write('title\noriginal');
        const row = store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(entry.id);
        store.getDb().prepare("UPDATE entries SET accessed_at = '2099-01-01T00:00:00Z' WHERE id = ?").run(entry.id);
        const remote = {
            key: entry.id,
            entityType: 'entry',
            operation: 'upsert',
            payload: JSON.stringify({
                ...row,
                content: 'STALE OVERWRITE',
                accessed_at: '2000-01-01T00:00:00Z',
                created_at: '2000-01-01T00:00:00Z',
            }),
            lwwTimestamp: Date.parse('2000-01-01T00:00:00Z'),
            lwwDevice: 'remote',
            lwwConfidence: 1.0,
            acked: false,
        };
        await store.applyStaging([remote]);
        const after = await store.read(entry.id);
        (0, vitest_1.expect)(after?.content).toBe('original');
    });
    (0, vitest_1.it)('concurrent logExchange produces monotonic seq + unique batch_index (F-STORE-005)', async () => {
        store = new index_js_1.TimStore(':memory:');
        const sessions = new index_js_1.SessionManager(store);
        await store.createProject('P0099');
        await sessions.startProjectSession({
            sessionId: 'sess-conc-1',
            projectId: 'P0099',
            agentName: 'test',
            cwd: '/tmp',
            harness: 'test',
            batchSize: 2,
        });
        const userMsg = (i) => ({ role: 'user', content: `u${i}` });
        await Promise.all([
            sessions.logExchange('sess-conc-1', [userMsg(1), userMsg(2), userMsg(3)]),
            sessions.logExchange('sess-conc-1', [userMsg(4), userMsg(5), userMsg(6)]),
        ]);
        const all = await collectDescendants(store, 'sess-conc-1');
        const userExchanges = all.filter(e => e.metadata.kind === 'exchange' && e.metadata.role === 'user');
        const seqs = userExchanges.map(e => e.metadata.seq).sort((a, b) => a - b);
        (0, vitest_1.expect)(seqs).toEqual([1, 2, 3, 4, 5, 6]);
        const batches = all.filter(e => e.metadata.kind === 'exchange-batch');
        const indices = batches.map(b => b.metadata.batch_index).sort((a, b) => a - b);
        const uniqueIndices = [...new Set(indices)];
        (0, vitest_1.expect)(indices.length).toBe(uniqueIndices.length);
    });
});
//# sourceMappingURL=sync-lifecycle.test.js.map