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
        (0, vitest_1.expect)(out).toMatch(/── Sessions \(1\) ──/);
        (0, vitest_1.expect)(out).toMatch(/^ {2}Sessions {2,}/m);
    });
});
//# sourceMappingURL=project-output.test.js.map