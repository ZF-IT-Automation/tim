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
        (0, vitest_1.expect)(out).toMatch(/── Sessions \(1\) ──/);
        (0, vitest_1.expect)(out).not.toMatch(/^ {2}Sessions /m);
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
    const entries = Array.from({ length: 5 }, (_, i) => ({
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
        (0, vitest_1.expect)(out).toMatch(/Entry 1/);
        (0, vitest_1.expect)(out).toMatch(/Entry 3/);
        (0, vitest_1.expect)(out).not.toMatch(/Entry 5/);
        (0, vitest_1.expect)(out).toMatch(/… 2 more$/m);
    });
    (0, vitest_1.it)('shows last N children when schema sets render_tail', () => {
        const schema = { sections: [{ name: 'Log', render_tail: true }] };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [log, ...entries], truncated: false }, 200, schema);
        (0, vitest_1.expect)(out).toMatch(/Entry 3/);
        (0, vitest_1.expect)(out).toMatch(/Entry 4/);
        (0, vitest_1.expect)(out).toMatch(/Entry 5/);
        (0, vitest_1.expect)(out).not.toMatch(/Entry 1\b/);
        (0, vitest_1.expect)(out).toMatch(/… 2 more \(older\)$/m);
    });
    (0, vitest_1.it)('per-entry metadata.render_tail overrides schema', () => {
        const tailLog = { ...log, metadata: { ...log.metadata, render_tail: true } };
        const out = (0, project_output_js_1.formatProjectOutput)({ project, children: [tailLog, ...entries], truncated: false }, 200);
        (0, vitest_1.expect)(out).toMatch(/Entry 5/);
        (0, vitest_1.expect)(out).toMatch(/… 2 more \(older\)$/m);
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