"use strict";
// TIM Store — Curation tool tests
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
(0, vitest_1.describe)('CurateManager', () => {
    (0, vitest_1.describe)('renameEntry', () => {
        (0, vitest_1.it)('should rename entry and update child parent_id references', async () => {
            await store.write('Parent', { id: 'OLD-ID' });
            const child = await store.write('Child', { parentId: 'OLD-ID' });
            await store.link('OLD-ID', child.id, 'relates');
            const renamed = store.curate().renameEntry('OLD-ID', 'NEW-ID');
            (0, vitest_1.expect)(renamed.id).toBe('NEW-ID');
            (0, vitest_1.expect)(await store.read('OLD-ID')).toBeNull();
            (0, vitest_1.expect)(await store.read('NEW-ID')).not.toBeNull();
            const readChild = await store.read(child.id);
            (0, vitest_1.expect)(readChild.parentId).toBe('NEW-ID');
            const edges = await store.getEdges('NEW-ID', 'outgoing');
            (0, vitest_1.expect)(edges.some(e => e.targetId === child.id)).toBe(true);
        });
        (0, vitest_1.it)('should reject rename when newId already exists', async () => {
            await store.write('First', { id: 'EXISTING' });
            await store.write('Second', { id: 'TO-RENAME' });
            (0, vitest_1.expect)(() => store.curate().renameEntry('TO-RENAME', 'EXISTING'))
                .toThrow('Entry already exists: EXISTING');
        });
        (0, vitest_1.it)('should stage renamed entry for sync', async () => {
            await store.write('Staged', { id: 'STAGE-OLD' });
            store.curate().renameEntry('STAGE-OLD', 'STAGE-NEW');
            const staging = await store.getStaging();
            const keys = staging.map(s => s.key);
            (0, vitest_1.expect)(keys).toContain('STAGE-NEW');
        });
    });
    (0, vitest_1.describe)('moveEntry', () => {
        (0, vitest_1.it)('should move entry and cascade depth to descendants', async () => {
            const root = await store.write('Root');
            const branch = await store.write('Branch');
            const leaf = await store.write('Leaf', { parentId: branch.id });
            const grandchild = await store.write('Grand', { parentId: leaf.id });
            (0, vitest_1.expect)(branch.depth).toBe(1);
            (0, vitest_1.expect)(leaf.depth).toBe(2);
            (0, vitest_1.expect)(grandchild.depth).toBe(3);
            store.curate().moveEntry(branch.id, root.id);
            const moved = await store.read(branch.id);
            (0, vitest_1.expect)(moved.parentId).toBe(root.id);
            (0, vitest_1.expect)(moved.depth).toBe(2);
            const movedLeaf = await store.read(leaf.id);
            (0, vitest_1.expect)(movedLeaf.depth).toBe(3);
            const movedGrand = await store.read(grandchild.id);
            (0, vitest_1.expect)(movedGrand.depth).toBe(4);
        });
        (0, vitest_1.it)('materializes secret inside transaction when moved under secret parent', async () => {
            const deviceStore = new store_js_1.TimStore(':memory:', { deviceId: 'device-abc' });
            const secretParent = await deviceStore.write('Secret parent', {
                metadata: { secret: true },
            });
            const child = await deviceStore.write('Will inherit', { parentId: null });
            const grand = await deviceStore.write('Grandchild', { parentId: child.id });
            deviceStore.curate().moveEntry(child.id, secretParent.id);
            const db = deviceStore.getDb();
            for (const id of [child.id, grand.id]) {
                const row = db.prepare('SELECT metadata, lww_device FROM entries WHERE id = ?').get(id);
                (0, vitest_1.expect)(JSON.parse(row.metadata).secret).toBe(true);
                (0, vitest_1.expect)(row.lww_device).toBe('device-abc');
            }
            const staging = db.prepare('SELECT lww_device FROM staging WHERE key = ?').get(child.id);
            (0, vitest_1.expect)(staging.lww_device).toBe('device-abc');
            deviceStore.close();
        });
    });
    (0, vitest_1.describe)('updateMany', () => {
        (0, vitest_1.it)('should batch-update irrelevant and favorite flags', async () => {
            const a = await store.write('A');
            const b = await store.write('B');
            const updated = store.curate().updateMany([a.id, b.id], {
                irrelevant: true,
                favorite: true,
            });
            (0, vitest_1.expect)(updated).toHaveLength(2);
            (0, vitest_1.expect)(updated.every(e => e.irrelevant && e.favorite)).toBe(true);
            const readA = await store.read(a.id, { showIrrelevant: true });
            (0, vitest_1.expect)(readA.favorite).toBe(true);
        });
    });
    (0, vitest_1.describe)('tagAdd', () => {
        (0, vitest_1.it)('should add tags without duplicates', async () => {
            const entry = await store.write('Tagged', { tags: ['#existing'] });
            const updated = store.curate().tagAdd(entry.id, ['#new', '#existing']);
            (0, vitest_1.expect)(updated.tags).toEqual(['#existing', '#new']);
        });
    });
    (0, vitest_1.describe)('tagRemove', () => {
        (0, vitest_1.it)('should remove specified tags', async () => {
            const entry = await store.write('Tagged', { tags: ['#keep', '#drop'] });
            const updated = store.curate().tagRemove(entry.id, ['#drop']);
            (0, vitest_1.expect)(updated.tags).toEqual(['#keep']);
        });
    });
    (0, vitest_1.describe)('tagRename', () => {
        (0, vitest_1.it)('should rename tag across all entries', async () => {
            await store.write('One', { tags: ['#old'] });
            await store.write('Two', { tags: ['#old', '#other'] });
            const count = store.curate().tagRename('#old', '#new');
            (0, vitest_1.expect)(count).toBe(2);
            const stats = await store.stats();
            const tagNames = stats.topTags.map(t => t.tag);
            (0, vitest_1.expect)(tagNames).toContain('#new');
            (0, vitest_1.expect)(tagNames).not.toContain('#old');
        });
        (0, vitest_1.it)('should not corrupt tags that merely contain the old tag as substring', async () => {
            const entry = await store.write('SQLite entry', { tags: ['#sqlite', '#sql'] });
            store.curate().tagRename('#sql', '#nosql');
            const read = await store.read(entry.id);
            (0, vitest_1.expect)(read.tags).toContain('#sqlite');
            (0, vitest_1.expect)(read.tags).toContain('#nosql');
            (0, vitest_1.expect)(read.tags).not.toContain('#sql');
        });
    });
});
//# sourceMappingURL=curate.test.js.map