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
    expect(out).toMatch(/── Recent Sessions \(1\/1\) ──/);
    expect(out).not.toMatch(/^ {2}Sessions /m);
  });
});

describe('formatProjectOutput recent sessions', () => {
  const project = {
    id: 'P1',
    metadata: { label: 'P1', kind: 'project' },
    title: 'P1 — x',
    content: '',
    tags: [],
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const sessions = Array.from({ length: 8 }, (_, i) => ({
    id: `sess-${i + 1}`,
    parentId: 'sess-root',
    title: `Session ${i + 1} — ${i + 1} exchanges`,
    metadata: { kind: 'session-summary-root' },
    tags: ['#session-summary'],
    content: '',
    // createdAt ascending → session 8 newest
    createdAt: `2026-06-0${i + 1}T00:00:00Z`,
  })) as any[];

  it('shows only the last 5 newest sessions with older count', () => {
    const out = formatProjectOutput({ project, children: sessions, truncated: false }, 500);
    expect(out).toMatch(/── Recent Sessions \(5\/8\) ──/);
    // newest is session 8 (2026-06-08), oldest shown is session 4 (2026-06-04)
    expect(out).toMatch(/2026-06-08/);
    expect(out).toMatch(/2026-06-04/);
    expect(out).not.toMatch(/2026-06-03/);
    expect(out).toMatch(/… 3 older sessions/);
  });

  it('no older line when sessions <= 5', () => {
    const out = formatProjectOutput(
      { project, children: sessions.slice(0, 3), truncated: false },
      500,
    );
    expect(out).toMatch(/── Recent Sessions \(3\/3\) ──/);
    expect(out).not.toMatch(/older sessions/);
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

describe('formatProjectOutput project summary', () => {
  it('renders Project Summary block and keeps it out of the description', () => {
    const project = {
      id: 'P1',
      metadata: { label: 'P1', kind: 'project' },
      title: 'P1 — Cool Thing | Active | the real description here',
      content: '## Project Summary\n- did A\n- did B\n- blocker: C',
      tags: [],
      createdAt: '2026-06-01T00:00:00Z',
    } as any;
    const out = formatProjectOutput({ project, children: [], truncated: false }, 200);
    expect(out).toMatch(/── Project Summary ──/);
    expect(out).toMatch(/did A/);
    expect(out).toMatch(/blocker: C/);
    expect(out).toMatch(/the real description here/);
    // marker heading itself must not leak into output
    expect(out).not.toMatch(/## Project Summary/);
  });

  it('omits the block when no summary present', () => {
    const project = {
      id: 'P1',
      metadata: { label: 'P1', kind: 'project' },
      title: 'P1 — x',
      content: 'plain description',
      tags: [],
      createdAt: '2026-06-01T00:00:00Z',
    } as any;
    const out = formatProjectOutput({ project, children: [], truncated: false }, 200);
    expect(out).not.toMatch(/── Project Summary ──/);
  });
});
