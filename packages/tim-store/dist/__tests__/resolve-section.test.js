"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const store_js_1 = require("../store.js");
(0, vitest_1.describe)('resolveSectionByTitle', () => {
    let store;
    (0, vitest_1.beforeEach)(() => {
        store = new store_js_1.TimStore(':memory:');
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.it)('returns found when exactly one section matches', async () => {
        const project = await store.createProject('P0062', { content: 'bbbee' });
        const section = await store.write('Tasks', { parentId: project.id });
        const r = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('found');
        if (r.status === 'found') {
            (0, vitest_1.expect)(r.id).toBe(section.id);
            (0, vitest_1.expect)(r.project).toBe('P0062');
            (0, vitest_1.expect)(r.title).toBe('Tasks');
        }
    });
    (0, vitest_1.it)('returns not_found with sibling section titles when zero matches', async () => {
        const project = await store.createProject('P0062', { content: 'bbbee' });
        await store.write('Tasks', { parentId: project.id });
        await store.write('Errors', { parentId: project.id });
        await store.write('Learnings', { parentId: project.id });
        const r = await store.resolveSectionByTitle('P0062', 'Decisions');
        (0, vitest_1.expect)(r.status).toBe('not_found');
        if (r.status === 'not_found') {
            (0, vitest_1.expect)(r.project).toBe('P0062');
            (0, vitest_1.expect)(r.title).toBe('Decisions');
            (0, vitest_1.expect)(r.candidates).toEqual(['Errors', 'Learnings', 'Tasks']);
        }
    });
    (0, vitest_1.it)('returns not_found with empty candidates when project has no sections', async () => {
        await store.createProject('P0062', { content: 'bbbee' });
        const r = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('not_found');
        if (r.status === 'not_found') {
            (0, vitest_1.expect)(r.candidates).toEqual([]);
        }
    });
    (0, vitest_1.it)('returns ambiguous with full candidate list when multiple sections match', async () => {
        const project = await store.createProject('P0062', { content: 'bbbee' });
        // Simulate the real bug: an old hmem-imported Tasks section coexists
        // with the freshly-created one. Both are direct children of the project.
        const oldTasks = await store.write('Tasks', { parentId: project.id });
        const newTasks = await store.write('Tasks', { parentId: project.id });
        const r = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('ambiguous');
        if (r.status === 'ambiguous') {
            (0, vitest_1.expect)(r.project).toBe('P0062');
            (0, vitest_1.expect)(r.title).toBe('Tasks');
            (0, vitest_1.expect)(r.candidates).toHaveLength(2);
            const ids = r.candidates.map(c => c.id);
            (0, vitest_1.expect)(ids).toContain(oldTasks.id);
            (0, vitest_1.expect)(ids).toContain(newTasks.id);
            for (const c of r.candidates) {
                (0, vitest_1.expect)(c.title).toBe('Tasks');
                (0, vitest_1.expect)(c.project).toBe('P0062');
                (0, vitest_1.expect)(c.depth).toBe(2);
                (0, vitest_1.expect)(typeof c.createdAt).toBe('string');
                (0, vitest_1.expect)(c.createdAt.length).toBeGreaterThan(0);
            }
        }
    });
    (0, vitest_1.it)('candidate order is created_at ascending (oldest first)', async () => {
        const project = await store.createProject('P0062', { content: 'bbbee' });
        const first = await store.write('Tasks', { parentId: project.id });
        // Force a gap so the second write has a strictly later created_at.
        await new Promise(resolve => setTimeout(resolve, 5));
        const second = await store.write('Tasks', { parentId: project.id });
        const r = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('ambiguous');
        if (r.status === 'ambiguous') {
            (0, vitest_1.expect)(r.candidates[0].id).toBe(first.id);
            (0, vitest_1.expect)(r.candidates[1].id).toBe(second.id);
        }
    });
    (0, vitest_1.it)('does NOT match sections from a different project', async () => {
        const p62 = await store.createProject('P0062', { content: 'bbbee' });
        const p63 = await store.createProject('P0063', { content: 'tim' });
        await store.write('Tasks', { parentId: p62.id });
        await store.write('Tasks', { parentId: p63.id });
        await store.write('Errors', { parentId: p63.id });
        // P0062 sees only its own single Tasks section.
        const r62 = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r62.status).toBe('found');
        if (r62.status === 'found') {
            // The id must be a direct child of P0062, not P0063.
            const p62Project = (await store.read('P0062'));
            const p63Project = (await store.read('P0063'));
            const childParent = store.getDb()
                .prepare('SELECT parent_id FROM entries WHERE id = ?')
                .get(r62.id);
            (0, vitest_1.expect)(childParent.parent_id).toBe(p62Project.id);
            (0, vitest_1.expect)(childParent.parent_id).not.toBe(p63Project.id);
        }
        // P0063 lookup of 'Errors' returns found (sibling, not a Tasks collision).
        const r63 = await store.resolveSectionByTitle('P0063', 'Errors');
        (0, vitest_1.expect)(r63.status).toBe('found');
        // P0063 lookup of 'Bugs' (not present) returns not_found — and the
        // candidate list must only contain P0063 sections, not P0062's.
        const r63missing = await store.resolveSectionByTitle('P0063', 'Bugs');
        (0, vitest_1.expect)(r63missing.status).toBe('not_found');
        if (r63missing.status === 'not_found') {
            (0, vitest_1.expect)(r63missing.candidates).toEqual(['Errors', 'Tasks']);
        }
        // P0062 lookup of 'Bugs' also returns not_found — and lists P0062 sections.
        const r62missing = await store.resolveSectionByTitle('P0062', 'Bugs');
        (0, vitest_1.expect)(r62missing.status).toBe('not_found');
        if (r62missing.status === 'not_found') {
            (0, vitest_1.expect)(r62missing.candidates).toEqual(['Tasks']);
        }
    });
    (0, vitest_1.it)('ignores irrelevant (soft-deleted) sections', async () => {
        const project = await store.createProject('P0062', { content: 'bbbee' });
        const live = await store.write('Tasks', { parentId: project.id });
        const dead = await store.write('Tasks', { parentId: project.id });
        // Mark dead as irrelevant via curate (update() refuses falsy flags).
        const curate = store.curate?.();
        if (curate?.updateMany) {
            curate.updateMany([dead.id], { irrelevant: true });
        }
        else {
            // Fallback: direct DB write if curate is internal-only.
            store.getDb().prepare('UPDATE entries SET irrelevant = 1 WHERE id = ?').run(dead.id);
        }
        const r = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('found');
        if (r.status === 'found') {
            (0, vitest_1.expect)(r.id).toBe(live.id);
        }
    });
    (0, vitest_1.it)('returns not_found for unknown project', async () => {
        const r = await store.resolveSectionByTitle('NOPE', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('not_found');
    });
    (0, vitest_1.it)('resolves project by alias, not only direct label', async () => {
        const project = await store.createProject('P0062', {
            content: 'bbbee',
            aliases: ['pm'],
        });
        await store.write('Tasks', { parentId: project.id });
        const r = await store.resolveSectionByTitle('pm', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('found');
        if (r.status === 'found') {
            (0, vitest_1.expect)(r.project).toBe('P0062');
        }
    });
    (0, vitest_1.it)('does NOT include nested children (only direct children of project root)', async () => {
        const project = await store.createProject('P0062', { content: 'bbbee' });
        const tasks = await store.write('Tasks', { parentId: project.id });
        // A nested "Tasks" deeper in the tree must not be a section candidate.
        await store.write('Tasks', { parentId: tasks.id });
        const r = await store.resolveSectionByTitle('P0062', 'Tasks');
        (0, vitest_1.expect)(r.status).toBe('found');
        if (r.status === 'found') {
            (0, vitest_1.expect)(r.id).toBe(tasks.id);
        }
    });
});
//# sourceMappingURL=resolve-section.test.js.map