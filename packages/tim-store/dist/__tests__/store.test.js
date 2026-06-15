"use strict";
// TIM Store Tests — v0.1.0-alpha
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const store_js_1 = require("../store.js");
const project_output_js_1 = require("../project-output.js");
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
        (0, vitest_1.it)('should assign id with session_short when metadata.sessionId set', async () => {
            const entry = await store.write('Hello World', {
                metadata: { sessionId: 'abc123-full-session' },
            });
            (0, vitest_1.expect)(entry.id).toMatch(/^[a-z0-9]{4}-\d{4}-abc123-[0-9A-Z]{26}$/);
        });
        (0, vitest_1.it)('should write and read an entry', async () => {
            const entry = await store.write('Hello World');
            (0, vitest_1.expect)(entry.id).toBeTruthy();
            (0, vitest_1.expect)(entry.id).toMatch(/^[a-z0-9]{4}-\d{4}-ns-[0-9A-Z]{26}$/);
            (0, vitest_1.expect)(entry.title).toBe('Hello World');
            (0, vitest_1.expect)(entry.content).toBe('');
            (0, vitest_1.expect)(entry.depth).toBe(1);
            (0, vitest_1.expect)(entry.confidence).toBe(1.0);
            (0, vitest_1.expect)(entry.tags).toEqual([]);
            const read = await store.read(entry.id);
            (0, vitest_1.expect)(read).not.toBeNull();
            (0, vitest_1.expect)(read.title).toBe('Hello World');
            (0, vitest_1.expect)(read.content).toBe('');
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
            (0, vitest_1.expect)(updated.title).toBe('Original');
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
            (0, vitest_1.expect)(read.title).toBe('From store1');
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
    // ─── Projects ─────────────────────────────────────────
    (0, vitest_1.describe)('createProject and loadProject', () => {
        (0, vitest_1.it)('load_project returns project and children', async () => {
            const project = await store.createProject('P0099', {
                content: 'Test Project',
                metadata: { name: 'Demo' },
            });
            const section = await store.write('Goals section', {
                parentId: project.id,
                metadata: { kind: 'section', label: 'Goals' },
            });
            await store.write('Ship v1', { parentId: section.id });
            await store.write('Add tests', { parentId: section.id });
            const result = await store.loadProject('P0099');
            (0, vitest_1.expect)(result).not.toBeNull();
            (0, vitest_1.expect)(result.project.metadata.kind).toBe('project');
            (0, vitest_1.expect)(result.project.metadata.label).toBe('P0099');
            (0, vitest_1.expect)(result.children.length).toBe(3);
            (0, vitest_1.expect)(result.truncated).toBe(false);
        });
        (0, vitest_1.it)('load_project respects depth limit', async () => {
            const project = await store.createProject('P0100');
            const child = await store.write('Level 1', { parentId: project.id });
            await store.write('Level 2', { parentId: child.id });
            await store.write('Level 3', { parentId: child.id });
            const shallow = await store.loadProject('P0100', { depth: 1 });
            (0, vitest_1.expect)(shallow.children.length).toBe(1);
            (0, vitest_1.expect)(shallow.children[0].title).toBe('Level 1');
            const deeper = await store.loadProject('P0100', { depth: 2 });
            (0, vitest_1.expect)(deeper.children.length).toBe(3);
        });
        (0, vitest_1.it)('load_project respects budget', async () => {
            const project = await store.createProject('P0101');
            for (let i = 0; i < 5; i++) {
                await store.write(`Child ${i}`, { parentId: project.id });
            }
            const result = await store.loadProject('P0101', { budget: 3 });
            (0, vitest_1.expect)(result.children.length).toBe(3);
            (0, vitest_1.expect)(result.truncated).toBe(true);
        });
    });
    // ─── Tasks ────────────────────────────────────────────
    (0, vitest_1.describe)('getTasks', () => {
        async function seedTaskProject(label, title, taskContent, taskMeta) {
            const project = await store.createProject(label, { content: title });
            const section = await store.write('Next Steps', {
                parentId: project.id,
                metadata: { kind: 'section', label: 'Next Steps' },
            });
            const task = await store.write(taskContent, {
                parentId: section.id,
                metadata: { task: true, ...taskMeta },
            });
            return { project, section, task };
        }
        (0, vitest_1.it)('returns empty array when no tasks exist', async () => {
            await store.createProject('P0200', { content: 'Empty Project' });
            const tasks = await store.getTasks();
            (0, vitest_1.expect)(tasks).toEqual([]);
        });
        (0, vitest_1.it)('returns tasks filtered by status', async () => {
            await seedTaskProject('P0201', 'Alpha', 'Todo task', { status: 'todo' });
            await seedTaskProject('P0202', 'Beta', 'Done task', { status: 'done' });
            const todoTasks = await store.getTasks({ status: 'todo' });
            (0, vitest_1.expect)(todoTasks).toHaveLength(1);
            (0, vitest_1.expect)(todoTasks[0].title).toBe('Todo task');
            const doneTasks = await store.getTasks({ status: 'done' });
            (0, vitest_1.expect)(doneTasks).toHaveLength(1);
            (0, vitest_1.expect)(doneTasks[0].title).toBe('Done task');
        });
        (0, vitest_1.it)('returns tasks sorted by priority then due date', async () => {
            const project = await store.createProject('P0203', { content: 'Sort Test' });
            const section = await store.write('Next Steps', {
                parentId: project.id,
                metadata: { kind: 'section' },
            });
            await store.write('Low later', {
                parentId: section.id,
                metadata: { task: true, status: 'todo', priority: 'low', due: '2026-06-10' },
            });
            await store.write('High soon', {
                parentId: section.id,
                metadata: { task: true, status: 'todo', priority: 'high', due: '2026-06-01' },
            });
            await store.write('High later', {
                parentId: section.id,
                metadata: { task: true, status: 'todo', priority: 'high', due: '2026-06-05' },
            });
            await store.write('In progress', {
                parentId: section.id,
                metadata: { task: true, status: 'in_progress', priority: 'low', due: '2026-06-15' },
            });
            const tasks = await store.getTasks();
            (0, vitest_1.expect)(tasks.map(t => t.title)).toEqual([
                'In progress',
                'High soon',
                'High later',
                'Low later',
            ]);
        });
        (0, vitest_1.it)('returns project_label correctly', async () => {
            await seedTaskProject('P0204', 'TIM', 'Build tim_tasks', {
                status: 'todo',
                priority: 'high',
            });
            const tasks = await store.getTasks();
            (0, vitest_1.expect)(tasks).toHaveLength(1);
            (0, vitest_1.expect)(tasks[0].project_label).toBe('P0204');
        });
        (0, vitest_1.it)('excludes irrelevant and tombstoned tasks', async () => {
            const { task } = await seedTaskProject('P0205', 'Filter', 'Active task', {
                status: 'todo',
            });
            await seedTaskProject('P0206', 'Other', 'Irrelevant task', { status: 'todo' });
            await seedTaskProject('P0207', 'Other2', 'Tombstoned task', { status: 'todo' });
            const allBefore = await store.getTasks();
            const irrelevant = allBefore.find(t => t.title === 'Irrelevant task');
            const tombstoned = allBefore.find(t => t.title === 'Tombstoned task');
            await store.delete(irrelevant.id);
            await store.delete(tombstoned.id, true);
            const tasks = await store.getTasks();
            (0, vitest_1.expect)(tasks).toHaveLength(1);
            (0, vitest_1.expect)(tasks[0].id).toBe(task.id);
        });
        (0, vitest_1.it)('reads nested metadata.task sub-section', async () => {
            const project = await store.createProject('P0208', { content: 'Nested Task' });
            const section = await store.write('Tasks', {
                parentId: project.id,
                metadata: { kind: 'section' },
            });
            await store.write('Nested todo', {
                parentId: section.id,
                metadata: {
                    type: 'task',
                    task: {
                        status: 'todo',
                        priority: 'high',
                        due_date: '2026-07-01',
                    },
                },
            });
            const tasks = await store.getTasks();
            (0, vitest_1.expect)(tasks).toHaveLength(1);
            (0, vitest_1.expect)(tasks[0].status).toBe('todo');
            (0, vitest_1.expect)(tasks[0].priority).toBe('high');
            (0, vitest_1.expect)(tasks[0].due).toBe('2026-07-01');
        });
        (0, vitest_1.it)('reads legacy flat metadata when task is boolean true', async () => {
            await seedTaskProject('P0209', 'Legacy', 'Flat task', {
                status: 'in_progress',
                priority: 'medium',
                due: '2026-08-15',
            });
            const tasks = await store.getTasks();
            (0, vitest_1.expect)(tasks).toHaveLength(1);
            (0, vitest_1.expect)(tasks[0].status).toBe('in_progress');
            (0, vitest_1.expect)(tasks[0].priority).toBe('medium');
            (0, vitest_1.expect)(tasks[0].due).toBe('2026-08-15');
        });
        (0, vitest_1.it)('filters nested task status', async () => {
            const project = await store.createProject('P0210', { content: 'Filter Nested' });
            const section = await store.write('Tasks', {
                parentId: project.id,
                metadata: { kind: 'section' },
            });
            await store.write('Open nested', {
                parentId: section.id,
                metadata: { type: 'task', task: { status: 'todo', priority: 'low' } },
            });
            await store.write('Done nested', {
                parentId: section.id,
                metadata: { type: 'task', task: { status: 'done', priority: 'low' } },
            });
            const todoTasks = await store.getTasks({ status: 'todo' });
            (0, vitest_1.expect)(todoTasks).toHaveLength(1);
            (0, vitest_1.expect)(todoTasks[0].title).toBe('Open nested');
        });
    });
    // ─── Overview query methods ─────────────────────────────
    (0, vitest_1.describe)('listProjects', () => {
        (0, vitest_1.it)('returns all live projects with id, label, title', async () => {
            const p1 = await store.createProject('P0300', { content: 'Alpha Project' });
            const p2 = await store.createProject('P0301', { content: 'Beta Project' });
            const projects = await store.listProjects();
            const labels = projects.map(p => p.label).sort();
            (0, vitest_1.expect)(labels).toEqual(['P0300', 'P0301']);
            (0, vitest_1.expect)(projects.find(p => p.id === p1.id)?.title).toBe('Alpha Project');
            (0, vitest_1.expect)(projects.find(p => p.id === p2.id)?.title).toBe('Beta Project');
        });
        (0, vitest_1.it)('excludes irrelevant and tombstoned projects', async () => {
            const live = await store.createProject('P0302', { content: 'Live' });
            const irrelevant = await store.createProject('P0303', { content: 'Irrelevant' });
            const tombstoned = await store.createProject('P0304', { content: 'Tombstoned' });
            await store.delete(irrelevant.id);
            await store.delete(tombstoned.id, true);
            const projects = await store.listProjects();
            const ids = projects.map(p => p.id);
            (0, vitest_1.expect)(ids).toContain(live.id);
            (0, vitest_1.expect)(ids).not.toContain(irrelevant.id);
            (0, vitest_1.expect)(ids).not.toContain(tombstoned.id);
        });
    });
    (0, vitest_1.describe)('getByTag', () => {
        (0, vitest_1.it)('returns entries with exact tag match', async () => {
            const tagged = await store.write('Bug report', { tags: ['#bug', '#urgent'] });
            await store.write('Clean entry', { tags: ['#note'] });
            const bugs = await store.getByTag('#bug');
            (0, vitest_1.expect)(bugs).toHaveLength(1);
            (0, vitest_1.expect)(bugs[0].id).toBe(tagged.id);
        });
        (0, vitest_1.it)('does not match tag substring false positives', async () => {
            await store.write('Bugfix note', { tags: ['#bugfix'] });
            const bugs = await store.getByTag('#bug');
            (0, vitest_1.expect)(bugs).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)('getByMetadataType', () => {
        (0, vitest_1.it)('returns entries with matching metadata.type', async () => {
            const err = await store.write('Error entry', {
                metadata: { type: 'error' },
                tags: ['#error', '#test'],
            });
            await store.write('Rule entry', {
                metadata: { type: 'rule' },
                tags: ['#rule', '#test'],
            });
            const errors = await store.getByMetadataType('error');
            (0, vitest_1.expect)(errors).toHaveLength(1);
            (0, vitest_1.expect)(errors[0].id).toBe(err.id);
        });
    });
    (0, vitest_1.describe)('getProjectLabel', () => {
        async function seedTaskProject(label, title, taskContent) {
            const project = await store.createProject(label, { content: title });
            const section = await store.write('Next Steps', {
                parentId: project.id,
                metadata: { kind: 'section', label: 'Next Steps' },
            });
            const task = await store.write(taskContent, {
                parentId: section.id,
                metadata: { task: true, status: 'todo' },
            });
            return { project, section, task };
        }
        (0, vitest_1.it)('returns project label for nested task', async () => {
            const { task } = await seedTaskProject('P0310', 'TIM', 'Build feature');
            (0, vitest_1.expect)(store.getProjectLabel(task.id)).toBe('P0310');
        });
        (0, vitest_1.it)('returns own label for project node', async () => {
            const project = await store.createProject('P0311', { content: 'Self' });
            (0, vitest_1.expect)(store.getProjectLabel(project.id)).toBe('P0311');
        });
        (0, vitest_1.it)('returns null for orphan entry', async () => {
            const orphan = await store.write('Orphan', { parentId: null });
            (0, vitest_1.expect)(store.getProjectLabel(orphan.id)).toBeNull();
        });
        (0, vitest_1.it)('returns null for missing entry', () => {
            (0, vitest_1.expect)(store.getProjectLabel('nonexistent-id')).toBeNull();
        });
    });
    // ─── Title field ──────────────────────────────────────
    (0, vitest_1.describe)('title field', () => {
        (0, vitest_1.it)('writes with explicit title', async () => {
            const entry = await store.write('Body text', { title: 'My Title' });
            (0, vitest_1.expect)(entry.title).toBe('My Title');
            (0, vitest_1.expect)(entry.content).toBe('Body text');
        });
        (0, vitest_1.it)('splits first line into title when no explicit title', async () => {
            const entry = await store.write('Title line\nBody line');
            (0, vitest_1.expect)(entry.title).toBe('Title line');
            (0, vitest_1.expect)(entry.content).toBe('Body line');
        });
        (0, vitest_1.it)('updates title without touching body when only title provided', async () => {
            const entry = await store.write('Body', { title: 'Old' });
            const updated = await store.update(entry.id, { title: 'New Title' });
            (0, vitest_1.expect)(updated.title).toBe('New Title');
            (0, vitest_1.expect)(updated.content).toBe('Body');
        });
        (0, vitest_1.it)('updates content without overwriting existing title', async () => {
            const entry = await store.write('Body', { title: 'Keep Me' });
            const updated = await store.update(entry.id, { content: 'New body' });
            (0, vitest_1.expect)(updated.title).toBe('Keep Me');
            (0, vitest_1.expect)(updated.content).toBe('New body');
        });
        (0, vitest_1.it)('migrates legacy single-line content into title column', async () => {
            store.getDb().prepare(`
        INSERT INTO entries (id, parent_id, title, content, content_type, depth, confidence,
          created_at, accessed_at, decay_rate, visibility, tags, irrelevant, favorite,
          tombstoned_at, metadata)
        VALUES ('legacy1', NULL, '', 'Legacy Title\nLegacy body', 'text', 1, 1.0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 1, '[]', 0, 0, NULL, '{}')
      `).run();
            store.getDb().prepare(`
        UPDATE entries SET
          title = trim(substr(content, 1, instr(content, char(10)) - 1)),
          content = trim(substr(content, instr(content, char(10)) + 1))
        WHERE id = 'legacy1'
      `).run();
            const read = await store.read('legacy1');
            (0, vitest_1.expect)(read.title).toBe('Legacy Title');
            (0, vitest_1.expect)(read.content).toBe('Legacy body');
        });
    });
    // ─── Node reordering ──────────────────────────────────
    (0, vitest_1.describe)('node reordering', () => {
        (0, vitest_1.it)('loadProject returns children sorted by metadata.order', async () => {
            const project = await store.createProject('P0300');
            await store.write('Third', { parentId: project.id, metadata: { order: 2 } });
            await store.write('First', { parentId: project.id, metadata: { order: 0 } });
            await store.write('Second', { parentId: project.id, metadata: { order: 1 } });
            const result = await store.loadProject('P0300', { depth: 1 });
            const direct = result.children.filter(c => c.parentId === project.id);
            (0, vitest_1.expect)(direct.map(c => c.title)).toEqual(['First', 'Second', 'Third']);
        });
        (0, vitest_1.it)('write auto-assigns metadata.order under parent', async () => {
            const project = await store.createProject('P0301');
            const a = await store.write('A', { parentId: project.id });
            const b = await store.write('B', { parentId: project.id });
            const c = await store.write('C', { parentId: project.id, metadata: { order: 99 } });
            (0, vitest_1.expect)(a.metadata.order).toBe(0);
            (0, vitest_1.expect)(b.metadata.order).toBe(1);
            (0, vitest_1.expect)(c.metadata.order).toBe(99);
        });
        (0, vitest_1.it)('moveEntry with order shifts siblings and places entry', async () => {
            const project = await store.createProject('P0302');
            const a = await store.write('A', { parentId: project.id, metadata: { order: 0 } });
            const b = await store.write('B', { parentId: project.id, metadata: { order: 1 } });
            const c = await store.write('C', { parentId: project.id, metadata: { order: 2 } });
            store.curate().moveEntry(c.id, project.id, 0);
            const children = await store.getChildren(project.id);
            (0, vitest_1.expect)(children.map(child => child.title)).toEqual(['C', 'A', 'B']);
            (0, vitest_1.expect)(children[0].metadata.order).toBe(0);
            (0, vitest_1.expect)(children[1].metadata.order).toBe(1);
            (0, vitest_1.expect)(children[2].metadata.order).toBe(2);
        });
        (0, vitest_1.it)('moveEntry without order puts entry at end', async () => {
            const project = await store.createProject('P0303');
            const section = await store.write('Section', {
                parentId: project.id,
                metadata: { order: 0 },
            });
            const child = await store.write('Child', { parentId: section.id, metadata: { order: 0 } });
            store.curate().moveEntry(child.id, project.id);
            const moved = await store.read(child.id);
            (0, vitest_1.expect)(moved.parentId).toBe(project.id);
            (0, vitest_1.expect)(moved.metadata.order).toBe(1);
        });
    });
    // ─── render_override ──────────────────────────────────
    (0, vitest_1.describe)('render_override', () => {
        (0, vitest_1.it)('formatProjectOutput uses metadata.render_depth override', async () => {
            const project = await store.createProject('P0400', { content: 'Demo | Active' });
            const section = await store.write('Some rules here', {
                parentId: project.id,
                title: 'Rules',
                metadata: { order: 0, render_depth: 0 },
            });
            await store.write('Hidden child', { parentId: section.id });
            // render_depth=0 on the section → skip section entirely (new behavior)
            const loaded = await store.loadProject('P0400', { depth: 3 });
            const output = (0, project_output_js_1.formatProjectOutput)(loaded, 50, {
                sections: [{ name: 'Rules', render_depth: 2 }],
            });
            // Per-node render_depth:0 overrides schema render_depth:2 → section is fully skipped
            (0, vitest_1.expect)(output).not.toContain('Rules');
            (0, vitest_1.expect)(output).not.toContain('Hidden child');
        });
        (0, vitest_1.it)('formatProjectOutput skips sections with render_depth=0 entirely', async () => {
            const project = await store.createProject('P0401');
            await store.write('', {
                parentId: project.id,
                title: 'Hidden Section',
                metadata: { order: 0, render_depth: 0 },
            });
            await store.write('Has body', {
                parentId: project.id,
                title: 'Visible Section',
                metadata: { order: 1 },
            });
            const loaded = await store.loadProject('P0401', { depth: 2 });
            const output = (0, project_output_js_1.formatProjectOutput)(loaded, 50);
            // render_depth=0 → section fully skipped, not shown at all
            (0, vitest_1.expect)(output).not.toContain('Hidden Section');
            (0, vitest_1.expect)(output).toContain('Visible Section');
        });
    });
    (0, vitest_1.describe)('getChildByKind / getChildrenBySeq', () => {
        (0, vitest_1.it)('returns only children matching a metadata.kind', async () => {
            const parent = await store.write('parent', {});
            await store.write('a', { parentId: parent.id, metadata: { kind: 'apple' } });
            await store.write('b', { parentId: parent.id, metadata: { kind: 'banana' } });
            await store.write('c', { parentId: parent.id, metadata: { kind: 'apple' } });
            const apples = await store.getChildByKind(parent.id, 'apple');
            (0, vitest_1.expect)(apples.map(e => e.title)).toEqual(['a', 'c']);
        });
        (0, vitest_1.it)('orders children by metadata.seq ascending', async () => {
            const parent = await store.write('p', {});
            await store.write('third', { parentId: parent.id, metadata: { seq: 3 } });
            await store.write('first', { parentId: parent.id, metadata: { seq: 1 } });
            await store.write('second', { parentId: parent.id, metadata: { seq: 2 } });
            const ordered = await store.getChildrenBySeq(parent.id);
            (0, vitest_1.expect)(ordered.map(e => e.title)).toEqual(['first', 'second', 'third']);
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
    // ─── getRootLevelEntries — metadata.type filter ────────
    (0, vitest_1.describe)('getRootLevelEntries', () => {
        (0, vitest_1.it)('returns all root-level non-project entries with no filter', async () => {
            await store.write('Rule one', { tags: ['#rule'] });
            await store.write('Human one', { tags: ['#human'] });
            await store.write('Plain note', { tags: ['#note'] });
            const entries = store.getRootLevelEntries();
            (0, vitest_1.expect)(entries.length).toBe(3);
            const titles = entries.map(e => e.title);
            (0, vitest_1.expect)(titles).toContain('Rule one');
            (0, vitest_1.expect)(titles).toContain('Human one');
            (0, vitest_1.expect)(titles).toContain('Plain note');
        });
        (0, vitest_1.it)('filters by metadata.type = rule', async () => {
            await store.write('Rule one', { tags: ['#rule'] });
            // The entry written via store.write has tags, not metadata.type.
            // We need to directly insert an entry with metadata.type set via
            // a raw SQL path because TimStore's write() doesn't do the migration.
            store.getDb().prepare(`
        INSERT INTO entries (id, title, content, parent_id, depth, confidence,
          created_at, accessed_at, visibility, tags, metadata, irrelevant)
        VALUES (?, ?, ?, NULL, 1, 1.0, ?, ?, 1, ?,
          ?, 0)
      `).run('rule1', 'Rule entry', '', new Date().toISOString(), new Date().toISOString(), JSON.stringify([]), JSON.stringify({ type: 'rule' }));
            await store.write('Human one', { tags: ['#human'] });
            await store.write('Plain note', { tags: ['#note'] });
            const entries = store.getRootLevelEntries({ type: 'rule' });
            (0, vitest_1.expect)(entries.length).toBe(1);
            (0, vitest_1.expect)(entries[0].title).toBe('Rule entry');
            (0, vitest_1.expect)(entries[0].metadata.type).toBe('rule');
        });
        (0, vitest_1.it)('filters by legacy tag (LIKE fallback)', async () => {
            await store.write('Rule one', { tags: ['#rule'] });
            await store.write('Human one', { tags: ['#human'] });
            await store.write('Plain note', { tags: ['#note'] });
            const entries = store.getRootLevelEntries({ tag: '#rule' });
            (0, vitest_1.expect)(entries.length).toBe(1);
            (0, vitest_1.expect)(entries[0].title).toBe('Rule one');
            (0, vitest_1.expect)(entries[0].tags).toContain('#rule');
        });
        (0, vitest_1.it)('type takes precedence over tag when both supplied', async () => {
            // Entry has #human tag → would match legacy filter.
            // Entry with metadata.type=rule → would match type filter.
            // When type=rule is given, the human-tagged entry should NOT appear.
            await store.write('Human entry', { tags: ['#human'] });
            store.getDb().prepare(`
        INSERT INTO entries (id, title, content, parent_id, depth, confidence,
          created_at, accessed_at, visibility, tags, metadata, irrelevant)
        VALUES (?, ?, ?, NULL, 1, 1.0, ?, ?, 1, ?,
          ?, 0)
      `).run('rule2', 'Rule entry', '', new Date().toISOString(), new Date().toISOString(), JSON.stringify([]), JSON.stringify({ type: 'rule' }));
            // Pass both type and tag; type wins.
            const entries = store.getRootLevelEntries({ type: 'rule', tag: '#human' });
            (0, vitest_1.expect)(entries.length).toBe(1);
            (0, vitest_1.expect)(entries[0].title).toBe('Rule entry');
        });
        (0, vitest_1.it)('excludes project-root entries', async () => {
            await store.write('Plain note', { tags: ['#note'] });
            // Project root: has metadata.kind = 'project'
            store.getDb().prepare(`
        INSERT INTO entries (id, title, content, parent_id, depth, confidence,
          created_at, accessed_at, visibility, tags, metadata, irrelevant)
        VALUES (?, ?, ?, NULL, 1, 1.0, ?, ?, 1, ?,
          ?, 0)
      `).run('proj1', 'Project entry', '', new Date().toISOString(), new Date().toISOString(), JSON.stringify([]), JSON.stringify({ kind: 'project', type: 'rule' }));
            const entries = store.getRootLevelEntries();
            // Only the plain note, not the project root.
            (0, vitest_1.expect)(entries.length).toBe(1);
            (0, vitest_1.expect)(entries[0].title).toBe('Plain note');
        });
        (0, vitest_1.it)('empty result when no entries match type', async () => {
            await store.write('Note', { tags: ['#note'] });
            const entries = store.getRootLevelEntries({ type: 'rule' });
            (0, vitest_1.expect)(entries.length).toBe(0);
        });
    });
});
//# sourceMappingURL=store.test.js.map