"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const project_output_js_1 = require("../project-output.js");
(0, vitest_1.describe)('formatProjectOutput sessions rollup', () => {
    (0, vitest_1.it)('does not list the Sessions section twice', () => {
        const project = {
            id: 'P1',
            metadata: { label: 'P1', kind: 'project' },
            title: 'P1 — x',
            content: '',
            tags: [],
            createdAt: '2026-06-01T00:00:00Z',
        };
        const sessionsRoot = {
            id: 's-root',
            parentId: 'P1',
            title: 'Sessions',
            metadata: { kind: 'sessions-root', order: 1000 },
            tags: ['#sessions'],
            content: '',
            createdAt: '2026-06-01T00:00:00Z',
        };
        const summary = {
            id: 'sum',
            parentId: 'sess',
            title: 'Summary',
            metadata: {
                kind: 'session-summary-root',
                exchanges: 4,
                date: '2026-06-01',
                summary: 'did things',
            },
            tags: ['#session-summary'],
            content: 'did things',
            createdAt: '2026-06-01T00:00:00Z',
        };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [sessionsRoot, summary], truncated: false }, 200);
        // Sessions section (kind=sessions-root) should only appear in the dedicated rollup block, not as a regular section
        (0, vitest_1.expect)(out).toMatch(/── Recent Sessions \(1\/1\) ──/);
        (0, vitest_1.expect)(out).not.toMatch(/^ {2}Sessions /m);
    });
});
(0, vitest_1.describe)('formatProjectOutput recent sessions', () => {
    const project = {
        id: 'P1',
        metadata: { label: 'P1', kind: 'project' },
        title: 'P1 — x',
        content: '',
        tags: [],
        createdAt: '2026-06-01T00:00:00Z',
    };
    const sessions = Array.from({ length: 8 }, (_, i) => ({
        id: `sess-${i + 1}`,
        parentId: 'sess-root',
        title: `Session ${i + 1} — ${i + 1} exchanges`,
        metadata: { kind: 'session-summary-root' },
        tags: ['#session-summary'],
        content: '',
        // createdAt ascending → session 8 newest
        createdAt: `2026-06-0${i + 1}T00:00:00Z`,
    }));
    (0, vitest_1.it)('shows only the last 5 newest sessions with older count', () => {
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: sessions, truncated: false }, 500);
        (0, vitest_1.expect)(out).toMatch(/── Recent Sessions \(5\/8\) ──/);
        // newest is session 8 (2026-06-08), oldest shown is session 4 (2026-06-04)
        (0, vitest_1.expect)(out).toMatch(/2026-06-08/);
        (0, vitest_1.expect)(out).toMatch(/2026-06-04/);
        (0, vitest_1.expect)(out).not.toMatch(/2026-06-03/);
        (0, vitest_1.expect)(out).toMatch(/… 3 older sessions/);
    });
    (0, vitest_1.it)('no older line when sessions <= 5', () => {
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: sessions.slice(0, 3), truncated: false }, 500);
        (0, vitest_1.expect)(out).toMatch(/── Recent Sessions \(3\/3\) ──/);
        (0, vitest_1.expect)(out).not.toMatch(/older sessions/);
    });
});
(0, vitest_1.describe)('formatProjectOutput render_tail', () => {
    const project = {
        id: 'P1',
        metadata: { label: 'P1', kind: 'project' },
        title: 'P1 — x',
        content: '',
        tags: [],
        createdAt: '2026-06-01T00:00:00Z',
    };
    const log = {
        id: 'log',
        parentId: 'P1',
        title: 'Log',
        metadata: { order: 1 },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
    };
    const entries = Array.from({ length: 12 }, (_, i) => ({
        id: `log-${i + 1}`,
        parentId: 'log',
        title: `Entry ${i + 1}`,
        metadata: { order: i + 1 },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
    }));
    (0, vitest_1.it)('shows first N children by default (head)', () => {
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [log, ...entries], truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/  Log\n/);
        (0, vitest_1.expect)(out).toMatch(/Entry 1/);
        (0, vitest_1.expect)(out).toMatch(/Entry 10/);
        (0, vitest_1.expect)(out).not.toMatch(/Entry 11\b/);
        (0, vitest_1.expect)(out).toMatch(/… 2 more$/m);
    });
    (0, vitest_1.it)('shows last N children when schema sets render_tail', () => {
        const schema = { sections: [{ name: 'Log', render_tail: true }] };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [log, ...entries], truncated: false }, 200, schema);
        (0, vitest_1.expect)(out).toMatch(/Entry 3/);
        (0, vitest_1.expect)(out).toMatch(/Entry 11/);
        (0, vitest_1.expect)(out).toMatch(/Entry 12/);
        (0, vitest_1.expect)(out).not.toMatch(/Entry 1\b/);
        (0, vitest_1.expect)(out).not.toMatch(/Entry 2\b/);
        (0, vitest_1.expect)(out).toMatch(/… 2 more \(older\)$/m);
    });
    (0, vitest_1.it)('per-entry metadata.render_tail overrides schema', () => {
        const tailLog = { ...log, metadata: { ...log.metadata, render_tail: true } };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [tailLog, ...entries], truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Entry 12/);
        (0, vitest_1.expect)(out).toMatch(/… 2 more \(older\)$/m);
    });
});
(0, vitest_1.describe)('formatProjectOutput entry badges', () => {
    const project = {
        id: 'P1',
        metadata: { label: 'P1', kind: 'project' },
        title: 'P1 — x',
        content: '',
        tags: [],
        createdAt: '2026-06-01T00:00:00Z',
    };
    const section = {
        id: 'tasks',
        parentId: 'P1',
        title: 'Tasks',
        metadata: { order: 0 },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
    };
    (0, vitest_1.it)('renders task status badges', () => {
        const children = [
            section,
            {
                id: 't1',
                parentId: 'tasks',
                title: 'Ship feature',
                metadata: { order: 0, task: true, status: 'in_progress' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
            {
                id: 't2',
                parentId: 'tasks',
                title: 'Write docs',
                metadata: { order: 1, task: true, status: 'done' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
            {
                id: 't3',
                parentId: 'tasks',
                title: 'No status task',
                metadata: { order: 2, task: true },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
        ];
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Ship feature \[in_progress\]/);
        (0, vitest_1.expect)(out).toMatch(/Write docs \[done\]/);
        (0, vitest_1.expect)(out).toMatch(/No status task \[todo\]/);
    });
    (0, vitest_1.it)('renders error severity badges', () => {
        const log = { ...section, id: 'log', title: 'Log' };
        const children = [
            log,
            {
                id: 'e1',
                parentId: 'log',
                title: 'DB down',
                metadata: { order: 0, kind: 'error', severity: 'critical' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
            {
                id: 'e2',
                parentId: 'log',
                title: 'Slow query',
                metadata: { order: 1, kind: 'error', severity: 'high' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
            {
                id: 'e3',
                parentId: 'log',
                title: 'Typo in UI',
                metadata: { order: 2, kind: 'error', severity: 'low' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
            {
                id: 'e4',
                parentId: 'log',
                title: 'Unknown severity',
                metadata: { order: 3, kind: 'error' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
        ];
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/DB down \[critical\]/);
        (0, vitest_1.expect)(out).toMatch(/Slow query \[high\]/);
        (0, vitest_1.expect)(out).toMatch(/Typo in UI \[low\]/);
        (0, vitest_1.expect)(out).toMatch(/Unknown severity \[medium\]/);
    });
    (0, vitest_1.it)('omits badges on plain entries', () => {
        const children = [
            section,
            {
                id: 'n1',
                parentId: 'tasks',
                title: 'Plain note',
                metadata: { order: 0 },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
        ];
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Plain note/);
        (0, vitest_1.expect)(out).not.toMatch(/Plain note \[/);
    });
    (0, vitest_1.it)('renders [done] badge when task is integer 1', () => {
        const children = [
            section,
            {
                id: 't-int',
                parentId: 'tasks',
                title: 'Legacy int task',
                metadata: { order: 0, task: 1, status: 'done' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
        ];
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Legacy int task \[done\]/);
    });
    (0, vitest_1.it)('renders [done] badge when task is string "true"', () => {
        const children = [
            section,
            {
                id: 't-str',
                parentId: 'tasks',
                title: 'Legacy str task',
                metadata: { order: 0, task: 'true', status: 'done' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
        ];
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Legacy str task \[done\]/);
    });
    (0, vitest_1.it)('renders [done] badge when task is boolean true (regression)', () => {
        const children = [
            section,
            {
                id: 't-bool',
                parentId: 'tasks',
                title: 'Bool task',
                metadata: { order: 0, task: true, status: 'done' },
                tags: [],
                content: '',
                createdAt: '2026-06-01T00:00:00Z',
            },
        ];
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Bool task \[done\]/);
    });
    (0, vitest_1.it)('omits badge for false-like task values', () => {
        for (const task of [false, 0, 'false']) {
            const children = [
                section,
                {
                    id: `t-${String(task)}`,
                    parentId: 'tasks',
                    title: `Task ${String(task)}`,
                    metadata: { order: 0, task, status: 'done' },
                    tags: [],
                    content: '',
                    createdAt: '2026-06-01T00:00:00Z',
                },
            ];
            const out = (0, project_output_js_1.formatProjectOutput)({ project, children, truncated: false }, 200);
            (0, vitest_1.expect)(out).toMatch(new RegExp(`Task ${String(task)}`));
            (0, vitest_1.expect)(out).not.toMatch(new RegExp(`Task ${String(task)} \\[`));
        }
    });
});
(0, vitest_1.describe)('formatProjectOutput section block layout', () => {
    const project = {
        id: 'P1',
        metadata: { label: 'P1', kind: 'project' },
        title: 'P1 — x',
        content: '',
        tags: [],
        createdAt: '2026-06-01T00:00:00Z',
    };
    (0, vitest_1.it)('renders section name on its own line with body below', () => {
        const section = {
            id: 'rules',
            parentId: 'P1',
            title: 'Rules',
            metadata: { order: 0 },
            tags: [],
            content: 'Always use MCP for DB',
            createdAt: '2026-06-01T00:00:00Z',
        };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [section], truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/  Rules\n    Always use MCP for DB/);
    });
    (0, vitest_1.it)('shows No entries for empty section without children', () => {
        const section = {
            id: 'empty',
            parentId: 'P1',
            title: 'Ideas',
            metadata: { order: 0 },
            tags: [],
            content: '',
            createdAt: '2026-06-01T00:00:00Z',
        };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [section], truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/  Ideas\n    No entries/);
    });
    (0, vitest_1.it)('skips section entirely when render_depth is 0', () => {
        const section = {
            id: 'hidden-kids',
            parentId: 'P1',
            title: 'Archive',
            metadata: { order: 0, render_depth: 0 },
            tags: [],
            content: 'section body',
            createdAt: '2026-06-01T00:00:00Z',
        };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [section], truncated: false }, 200);
        (0, vitest_1.expect)(out).not.toContain('Archive');
    });
});
(0, vitest_1.describe)('formatProjectOutput project summary', () => {
    (0, vitest_1.it)('renders Project Summary block and keeps it out of the description', () => {
        const project = {
            id: 'P1',
            metadata: { label: 'P1', kind: 'project' },
            title: 'P1 — Cool Thing | Active | the real description here',
            content: '## Project Summary\n- did A\n- did B\n- blocker: C',
            tags: [],
            createdAt: '2026-06-01T00:00:00Z',
        };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [], truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/── Project Summary ──/);
        (0, vitest_1.expect)(out).toMatch(/did A/);
        (0, vitest_1.expect)(out).toMatch(/blocker: C/);
        (0, vitest_1.expect)(out).toMatch(/the real description here/);
        // marker heading itself must not leak into output
        (0, vitest_1.expect)(out).not.toMatch(/## Project Summary/);
    });
    (0, vitest_1.it)('omits the block when no summary present', () => {
        const project = {
            id: 'P1',
            metadata: { label: 'P1', kind: 'project' },
            title: 'P1 — x',
            content: 'plain description',
            tags: [],
            createdAt: '2026-06-01T00:00:00Z',
        };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [], truncated: false }, 200);
        (0, vitest_1.expect)(out).not.toMatch(/── Project Summary ──/);
    });
});
//# sourceMappingURL=project-output.test.js.map