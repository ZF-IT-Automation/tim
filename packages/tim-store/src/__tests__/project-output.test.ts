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
    // Sessions section (kind=sessions-root) should only appear in the dedicated rollup block, not as a regular section
    expect(out).toMatch(/── Sessions \(1\) ──/);
    expect(out).not.toMatch(/^ {2}Sessions /m);
  });
});

describe('formatProjectOutput render_tail', () => {
  const project = {
    id: 'P1',
    metadata: { label: 'P1', kind: 'project' },
    title: 'P1 — x',
    content: '',
    tags: [],
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const log = {
    id: 'log',
    parentId: 'P1',
    title: 'Log',
    metadata: { order: 1 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const entries = Array.from({ length: 5 }, (_, i) => ({
    id: `log-${i + 1}`,
    parentId: 'log',
    title: `Entry ${i + 1}`,
    metadata: { order: i + 1 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  })) as any[];

  it('shows first N children by default (head)', () => {
    const out = formatProjectOutput(
      { project, children: [log, ...entries], truncated: false },
      200,
    );
    expect(out).toMatch(/Entry 1/);
    expect(out).toMatch(/Entry 3/);
    expect(out).not.toMatch(/Entry 5/);
    expect(out).toMatch(/… 2 more$/m);
  });

  it('shows last N children when schema sets render_tail', () => {
    const schema = { sections: [{ name: 'Log', render_tail: true }] };
    const out = formatProjectOutput(
      { project, children: [log, ...entries], truncated: false },
      200,
      schema,
    );
    expect(out).toMatch(/Entry 3/);
    expect(out).toMatch(/Entry 4/);
    expect(out).toMatch(/Entry 5/);
    expect(out).not.toMatch(/Entry 1\b/);
    expect(out).toMatch(/… 2 more \(older\)$/m);
  });

  it('per-entry metadata.render_tail overrides schema', () => {
    const tailLog = { ...log, metadata: { ...log.metadata, render_tail: true } };
    const out = formatProjectOutput(
      { project, children: [tailLog, ...entries], truncated: false },
      200,
    );
    expect(out).toMatch(/Entry 5/);
    expect(out).toMatch(/… 2 more \(older\)$/m);
  });
});
