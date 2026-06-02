import { describe, it, expect } from 'vitest';
import { formatProjectOutput } from '../project-output.js';

describe('formatProjectOutput sessions rollup', () => {
  it('does not list the Sessions section twice', () => {
    const project = {
      id: 'P1',
      metadata: { label: 'P1', kind: 'project' },
      title: 'P1 — x',
      content: '',
      tags: [],
      createdAt: '2026-06-01T00:00:00Z',
    } as any;
    const sessionsRoot = {
      id: 's-root',
      parentId: 'P1',
      title: 'Sessions',
      metadata: { kind: 'sessions-root', order: 1000 },
      tags: ['#sessions'],
      content: '',
      createdAt: '2026-06-01T00:00:00Z',
    } as any;
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
    } as any;

    const out = formatProjectOutput({ project, children: [sessionsRoot, summary], truncated: false }, 200);
    expect(out).toMatch(/── Sessions \(1\) ──/);
    expect(out).toMatch(/^ {2}Sessions {2,}/m);
  });
});
