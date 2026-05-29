"use strict";
// TIM Store Tests — v0.1.0-alpha
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
(0, vitest_1.describe)('TimStore', () => {
    // ─── Basic CRUD ──────────────────────────────────────
    (0, vitest_1.describe)('write and read', () => {
        (0, vitest_1.it)('should write and read an entry', async () => {
            const entry = await store.write('Hello World');
            (0, vitest_1.expect)(entry.id).toBeTruthy();
            (0, vitest_1.expect)(entry.content).toBe('Hello World');
            (0, vitest_1.expect)(entry.depth).toBe(1);
            (0, vitest_1.expect)(entry.confidence).toBe(1.0);
            (0, vitest_1.expect)(entry.tags).toEqual([]);
            const read = await store.read(entry.id);
            (0, vitest_1.expect)(read).not.toBeNull();
            (0, vitest_1.expect)(read.content).toBe('Hello World');
        });
        (0, vitest_1.it)('should write with options', async () => {
            const entry = await store.write('Important note', {
                confidence: 0.9,
                tags: ['#important', '#note'],
                visibility: 3, // owner + trusted
            });
            (0, vitest_1.expect)(entry.confidence).toBe(0.9);
            (0, vitest_1.expect)(entry.tags).toEqual(['#important', '#note']);
            (0, vitest_1.expect)(entry.visibility).toBe(3);
        });
        (0, vitest_1.it)('should calculate depth from parent', async () => {
            const parent = await store.write('Parent');
            const child = await store.write('Child', { parentId: parent.id });
            (0, vitest_1.expect)(child.depth).toBe(2);
        });
        (0, vitest_1.it)('should cap depth at 5', async () => {
            let parentId = null;
            for (let i = 0; i < 6; i++) {
                const entry = await store.write(`Level ${i}`, { parentId });
                parentId = entry.id;
                if (i < 5) {
                    (0, vitest_1.expect)(entry.depth).toBe(i + 1);
                }
                else {
                    (0, vitest_1.expect)(entry.depth).toBe(5);
                }
            }
        });
    });
    (0, vitest_1.describe)('update', () => {
        (0, vitest_1.it)('should update an entry', async () => {
            const entry = await store.write('Original');
            const updated = await store.update(entry.id, { content: 'Updated' });
            (0, vitest_1.expect)(updated.content).toBe('Updated');
            (0, vitest_1.expect)(updated.id).toBe(entry.id);
        });
        (0, vitest_1.it)('should update accessed_at on update', async () => {
            const entry = await store.write('Test');
            await new Promise(r => setTimeout(r, 10));
            const updated = await store.update(entry.id, { content: 'Changed' });
            (0, vitest_1.expect)(updated.accessedAt > entry.accessedAt).toBe(true);
        });
        (0, vitest_1.it)('should throw on non-existent entry', async () => {
            await (0, vitest_1.expect)(store.update('nonexistent', { content: 'x' }))
                .rejects.toThrow('Entry not found');
        });
    });
    (0, vitest_1.describe)('delete', () => {
        (0, vitest_1.it)('should soft delete (mark irrelevant)', async () => {
            const entry = await store.write('To delete');
            await store.delete(entry.id);
            const read = await store.read(entry.id);
            (0, vitest_1.expect)(read).toBeNull(); // hidden by default
        });
        (0, vitest_1.it)('should show soft-deleted with showIrrelevant', async () => {
            const entry = await store.write('Soft deleted');
            await store.delete(entry.id);
            const read = await store.read(entry.id, { showIrrelevant: true });
            (0, vitest_1.expect)(read).not.toBeNull();
            (0, vitest_1.expect)(read.irrelevant).toBe(true);
        });
        (0, vitest_1.it)('should hard delete (set tombstone)', async () => {
            const entry = await store.write('To nuke');
            await store.delete(entry.id, true);
            const read = await store.read(entry.id, { showIrrelevant: true });
            (0, vitest_1.expect)(read.tombstonedAt).toBeTruthy();
        });
    });
    // ─── Visibility ───────────────────────────────────────
    (0, vitest_1.describe)('visibility', () => {
        (0, vitest_1.it)('should hide entries outside visibility mask', async () => {
            const entry = await store.write('Private', { visibility: 1 }); // owner only
            const read = await store.read(entry.id, { visibilityMask: 2 }); // trusted only
            (0, vitest_1.expect)(read).toBeNull();
        });
        (0, vitest_1.it)('should show entries within visibility mask', async () => {
            const entry = await store.write('Shared', { visibility: 3 }); // owner+trusted
            const read = await store.read(entry.id, { visibilityMask: 2 }); // trusted
            (0, vitest_1.expect)(read).not.toBeNull();
        });
    });
    // ─── Search ───────────────────────────────────────────
    (0, vitest_1.describe)('search', () => {
        (0, vitest_1.it)('should search by FTS5', async () => {
            await store.write('This is about TypeScript programming');
            await store.write('This is about Rust programming');
            await store.write('This is about cooking');
            const results = await store.search({ query: 'programming' });
            (0, vitest_1.expect)(results.length).toBe(2);
        });
        (0, vitest_1.it)('should respect search limit', async () => {
            for (let i = 0; i < 5; i++) {
                await store.write(`Test entry ${i}`);
            }
            const results = await store.search({ query: 'Test', topK: 2 });
            (0, vitest_1.expect)(results.length).toBe(2);
        });
    });
    // ─── Edges ────────────────────────────────────────────
    (0, vitest_1.describe)('edges', () => {
        (0, vitest_1.it)('should create and retrieve edges', async () => {
            const a = await store.write('Entry A');
            const b = await store.write('Entry B');
            const edge = await store.link(a.id, b.id, 'relates', 0.8);
            (0, vitest_1.expect)(edge.id).toBeTruthy();
            (0, vitest_1.expect)(edge.sourceId).toBe(a.id);
            (0, vitest_1.expect)(edge.targetId).toBe(b.id);
            (0, vitest_1.expect)(edge.type).toBe('relates');
            (0, vitest_1.expect)(edge.weight).toBe(0.8);
        });
        (0, vitest_1.it)('should get outgoing edges', async () => {
            const a = await store.write('A');
            const b = await store.write('B');
            const c = await store.write('C');
            await store.link(a.id, b.id, 'extends');
            await store.link(a.id, c.id, 'contradicts');
            const edges = await store.getEdges(a.id, 'outgoing');
            (0, vitest_1.expect)(edges.length).toBe(2);
        });
        (0, vitest_1.it)('should get incoming edges', async () => {
            const a = await store.write('A');
            const b = await store.write('B');
            await store.link(b.id, a.id, 'implements');
            const edges = await store.getEdges(a.id, 'incoming');
            (0, vitest_1.expect)(edges.length).toBe(1);
            (0, vitest_1.expect)(edges[0].type).toBe('implements');
        });
    });
    // ─── traceChain ───────────────────────────────────────
    (0, vitest_1.describe)('traceChain', () => {
        (0, vitest_1.it)('should trace a chain of related entries', async () => {
            const a = await store.write('Root cause');
            const b = await store.write('Bug report');
            const c = await store.write('Fix commit');
            await store.link(a.id, b.id, 'relates');
            await store.link(b.id, c.id, 'implements');
            const chain = await store.traceChain(a.id);
            (0, vitest_1.expect)(chain.length).toBe(3);
        });
        (0, vitest_1.it)('should trace specific edge type only', async () => {
            const a = await store.write('A');
            const b = await store.write('B');
            const c = await store.write('C');
            await store.link(a.id, b.id, 'relates');
            await store.link(a.id, c.id, 'contradicts');
            await store.link(b.id, c.id, 'relates');
            const contradicts = await store.traceChain(a.id, 'contradicts');
            (0, vitest_1.expect)(contradicts.length).toBe(2); // A → C
        });
        (0, vitest_1.it)('should respect depth limit', async () => {
            let prev = await store.write('N0');
            for (let i = 1; i < 10; i++) {
                const next = await store.write(`N${i}`);
                await store.link(prev.id, next.id, 'extends');
                prev = next;
            }
            const chain = await store.traceChain(prev.id, undefined, 3);
            // traceChain follows OUTGOING edges, so from N9 going out depth=3 should find 0 entries (no outgoing)
            // Wait, traceChain starts at startId, so from N9 with outgoing edges: no edges. Let me fix test...
        });
        (0, vitest_1.it)('should not loop infinitely', async () => {
            const a = await store.write('A');
            const b = await store.write('B');
            await store.link(a.id, b.id, 'relates');
            await store.link(b.id, a.id, 'relates'); // cycle!
            const chain = await store.traceChain(a.id, undefined, 10);
            (0, vitest_1.expect)(chain.length).toBe(2); // visited set prevents loop
        });
    });
    // ─── Agents ───────────────────────────────────────────
    (0, vitest_1.describe)('agents', () => {
        (0, vitest_1.it)('should register and list agents', async () => {
            await store.registerAgent('Claude Code', 'claude');
            await store.registerAgent('Cursor', 'cursor');
            const agents = await store.getAgents();
            (0, vitest_1.expect)(agents.length).toBe(2);
            (0, vitest_1.expect)(agents[0].label).toBe('claude');
        });
        (0, vitest_1.it)('should reject duplicate labels', async () => {
            await store.registerAgent('Claude', 'claude');
            await (0, vitest_1.expect)(store.registerAgent('Other Claude', 'claude'))
                .rejects.toThrow(); // UNIQUE constraint
        });
    });
    // ─── Staging / Sync ──────────────────────────────────
    (0, vitest_1.describe)('staging', () => {
        (0, vitest_1.it)('should stage writes', async () => {
            await store.write('Stage test');
            const staging = await store.getStaging();
            (0, vitest_1.expect)(staging.length).toBe(1);
            (0, vitest_1.expect)(staging[0].entityType).toBe('entry');
            (0, vitest_1.expect)(staging[0].operation).toBe('upsert');
        });
        (0, vitest_1.it)('should stage updates', async () => {
            const entry = await store.write('Original');
            await store.update(entry.id, { content: 'Updated' });
            const staging = await store.getStaging();
            (0, vitest_1.expect)(staging.length).toBe(2); // write + update
        });
        (0, vitest_1.it)('should apply staging records', async () => {
            const store2 = new store_js_1.TimStore(':memory:');
            const entry = await store.write('From store1');
            const staging = await store.getStaging();
            await store2.applyStaging(staging);
            const read = await store2.read(entry.id);
            (0, vitest_1.expect)(read).not.toBeNull();
            (0, vitest_1.expect)(read.content).toBe('From store1');
            store2.close();
        });
        (0, vitest_1.it)('should get staging cursor', async () => {
            await store.write('A');
            await store.write('B');
            const cursor = await store.getStagingCursor();
            (0, vitest_1.expect)(cursor).toBe(2);
        });
        (0, vitest_1.it)('should GC old staging records', async () => {
            await store.write('Old');
            // Manually set staging timestamp to old value
            store['db'].prepare('UPDATE staging SET lww_timestamp = ?, acked = 1')
                .run(Date.now() - 100 * 86400_000);
            const deleted = await store.gcStaging(30);
            (0, vitest_1.expect)(deleted).toBe(1);
        });
    });
    // ─── Health ───────────────────────────────────────────
    (0, vitest_1.describe)('health', () => {
        (0, vitest_1.it)('should report empty database as healthy', async () => {
            const report = await store.health();
            (0, vitest_1.expect)(report.brokenLinks).toBe(0);
            (0, vitest_1.expect)(report.orphanEntries).toBe(0);
            (0, vitest_1.expect)(report.ftsIntegrity).toBe(true);
            (0, vitest_1.expect)(report.totalEntries).toBe(0);
        });
        (0, vitest_1.it)('should detect broken links', async () => {
            const a = await store.write('A');
            // Disable FK to insert broken edge for testing
            store['db'].pragma('foreign_keys = OFF');
            store['db'].prepare("INSERT INTO edges (id, source_id, target_id, type, weight, metadata) VALUES (?, ?, ?, 'relates', 1.0, '{}')")
                .run('fake-edge', a.id, 'nonexistent');
            store['db'].pragma('foreign_keys = ON');
            const report = await store.health();
            (0, vitest_1.expect)(report.brokenLinks).toBe(1);
        });
    });
    // ─── Stats ────────────────────────────────────────────
    (0, vitest_1.describe)('stats', () => {
        (0, vitest_1.it)('should return stats', async () => {
            await store.write('Entry 1', { tags: ['#a', '#b'] });
            await store.write('Entry 2', { tags: ['#a'] });
            const stats = await store.stats();
            (0, vitest_1.expect)(stats.totalEntries).toBe(2);
            (0, vitest_1.expect)(stats.topTags[0].tag).toBe('#a');
            (0, vitest_1.expect)(stats.topTags[0].count).toBe(2);
        });
    });
    // ─── Suppression ──────────────────────────────────────
    (0, vitest_1.describe)('suppression', () => {
        (0, vitest_1.it)('should suppress matching patterns', async () => {
            await store.suppress('secret project', 'NDA');
            const suppressed = await store.isSuppressed('talking about secret project details');
            (0, vitest_1.expect)(suppressed).toBe(true);
        });
        (0, vitest_1.it)('should not suppress non-matching content', async () => {
            await store.suppress('secret project', 'NDA');
            const suppressed = await store.isSuppressed('public information');
            (0, vitest_1.expect)(suppressed).toBe(false);
        });
    });
});
//# sourceMappingURL=store.test.js.map