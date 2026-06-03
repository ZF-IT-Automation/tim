"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const index_js_1 = require("../index.js");
const commit_tree_js_1 = require("../commit-tree.js");
const session_tree_js_1 = require("../session-tree.js");
(0, vitest_1.describe)('CommitManager', () => {
    let store;
    let commits;
    (0, vitest_1.beforeEach)(() => {
        store = new index_js_1.TimStore(':memory:');
        commits = new index_js_1.CommitManager(store);
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.it)('creates Commits section on first record', async () => {
        await store.createProject('P0002', { content: 'Test project' });
        await commits.recordCommit({
            projectId: 'P0002',
            hash: 'abc123def456',
            message: 'feat: first commit',
        });
        const project = await store.read('P0002');
        const sections = await store.getChildByKind(project.id, commit_tree_js_1.KIND_COMMITS_ROOT);
        (0, vitest_1.expect)(sections).toHaveLength(1);
        (0, vitest_1.expect)(sections[0].title).toBe('Commits');
    });
    (0, vitest_1.it)('writes hash as title and message + diff as body', async () => {
        await store.createProject('P0002', { content: 'Test project' });
        const entry = await commits.recordCommit({
            projectId: 'P0002',
            hash: 'deadbeef',
            message: 'fix: bug',
            diffSummary: ' src/a.ts | 2 ++\n 1 file changed',
        });
        (0, vitest_1.expect)(entry.title).toBe('deadbeef');
        (0, vitest_1.expect)(entry.content).toContain('fix: bug');
        (0, vitest_1.expect)(entry.content).toContain('src/a.ts');
        (0, vitest_1.expect)(entry.metadata.kind).toBe(commit_tree_js_1.KIND_COMMIT);
        (0, vitest_1.expect)(entry.metadata.commit_hash).toBe('deadbeef');
    });
    (0, vitest_1.it)('is idempotent for the same hash', async () => {
        await store.createProject('P0002', { content: 'Test project' });
        const first = await commits.recordCommit({
            projectId: 'P0002',
            hash: 'samehash',
            message: 'first',
        });
        const second = await commits.recordCommit({
            projectId: 'P0002',
            hash: 'samehash',
            message: 'ignored duplicate',
        });
        (0, vitest_1.expect)(second.id).toBe(first.id);
        const section = await commits.ensureCommitsSection('P0002');
        const all = await store.getChildByKind(section.id, commit_tree_js_1.KIND_COMMIT);
        (0, vitest_1.expect)(all).toHaveLength(1);
    });
    (0, vitest_1.it)('recordCommit accepts project alias', async () => {
        await store.createProject('P0048', { content: 'o9k', aliases: ['o9k'] });
        const entry = await commits.recordCommit({
            projectId: 'o9k',
            hash: 'aliashash',
            message: 'via alias',
        });
        (0, vitest_1.expect)(entry.metadata.kind).toBe(commit_tree_js_1.KIND_COMMIT);
        const project = await store.read('P0048');
        const section = await store.getChildByKind(project.id, commit_tree_js_1.KIND_COMMITS_ROOT);
        (0, vitest_1.expect)(section).toHaveLength(1);
    });
    (0, vitest_1.it)('rejects nonexistent project', async () => {
        await (0, vitest_1.expect)(commits.recordCommit({
            projectId: 'P9999',
            hash: 'nope',
            message: 'x',
        })).rejects.toThrow(/Project not found: P9999/);
    });
    (0, vitest_1.it)('links commit and session via relates / implements', async () => {
        await store.createProject('P0002', { content: 'Test project' });
        const session = await store.write('Session test', {
            id: 'sess-commit',
            metadata: { kind: session_tree_js_1.KIND_SESSION, sessionId: 'sess-commit' },
            tags: ['#session'],
        });
        const commit = await commits.recordCommit({
            projectId: 'P0002',
            hash: 'linkhash',
            message: 'feat: linked',
            sessionId: session.id,
        });
        const out = await store.getEdges(commit.id, 'outgoing');
        const inc = await store.getEdges(session.id, 'outgoing');
        (0, vitest_1.expect)(out.some(e => e.targetId === session.id && e.type === 'relates')).toBe(true);
        (0, vitest_1.expect)(inc.some(e => e.targetId === commit.id && e.type === 'implements')).toBe(true);
    });
});
//# sourceMappingURL=commit.test.js.map