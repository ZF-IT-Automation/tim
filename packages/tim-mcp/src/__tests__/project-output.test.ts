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

  const entries = Array.from({ length: 12 }, (_, i) => ({
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
    expect(out).toMatch(/  Log\n/);
    expect(out).toMatch(/Entry 1/);
    expect(out).toMatch(/Entry 10/);
    expect(out).not.toMatch(/Entry 11\b/);
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
    expect(out).toMatch(/Entry 11/);
    expect(out).toMatch(/Entry 12/);
    expect(out).not.toMatch(/Entry 1\b/);
    expect(out).not.toMatch(/Entry 2\b/);
    expect(out).toMatch(/… 2 more \(older\)$/m);
  });

  it('per-entry metadata.render_tail overrides schema', () => {
    const tailLog = { ...log, metadata: { ...log.metadata, render_tail: true } };
    const out = formatProjectOutput(
      { project, children: [tailLog, ...entries], truncated: false },
      200,
    );
    expect(out).toMatch(/Entry 12/);
    expect(out).toMatch(/… 2 more \(older\)$/m);
  });
});

describe('formatProjectOutput entry badges', () => {
  const project = {
    id: 'P1',
    metadata: { label: 'P1', kind: 'project' },
    title: 'P1 — x',
    content: '',
    tags: [],
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const section = {
    id: 'tasks',
    parentId: 'P1',
    title: 'Tasks',
    metadata: { order: 0 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  it('renders task status badges', () => {
    // T3 fix: status lives at metadata.task.status, not metadata.status.
    // Legacy metadata.status is ignored — see project-output-badge.test.ts
    // for the explicit regression tests.
    const children = [
      section,
      {
        id: 't1',
        parentId: 'tasks',
        title: 'Ship feature',
        metadata: { order: 0, task: { status: 'in_progress' } },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
      {
        id: 't2',
        parentId: 'tasks',
        title: 'Write docs',
        metadata: { order: 1, task: { status: 'done' } },
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
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Ship feature \[in_progress\]/);
    expect(out).toMatch(/Write docs \[done\]/);
    expect(out).toMatch(/No status task \[todo\]/);
  });

  it('renders error severity badges', () => {
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
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/DB down \[critical\]/);
    expect(out).toMatch(/Slow query \[high\]/);
    expect(out).toMatch(/Typo in UI \[low\]/);
    expect(out).toMatch(/Unknown severity \[medium\]/);
  });

  it('omits badges on plain entries', () => {
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
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Plain note/);
    expect(out).not.toMatch(/Plain note \[/);
  });

  it('renders [done] badge when task is integer 1 (legacy coercion)', () => {
    // T3 fix: task:1 is coerced to true (recognized as task marker), but
    // there's no task.status object on this legacy entry. The badge
    // should still render — with the default 'todo' fallback, not the
    // legacy top-level status field (which is now ignored).
    const children = [
      section,
      {
        id: 't-int',
        parentId: 'tasks',
        title: 'Legacy int task',
        metadata: { order: 0, task: 1 },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    // task:1 → isTaskMarker=true → badge renders with default 'todo' status
    expect(out).toMatch(/Legacy int task \[todo\]/);
  });

  it('renders [done] badge when task is string "true" (legacy coercion)', () => {
    // Same as above for task:'true' — recognized as marker, no status
    // object → defaults to 'todo'. (Name kept for backwards-compat
    // tracing of the historical bug this test was written for.)
    const children = [
      section,
      {
        id: 't-str',
        parentId: 'tasks',
        title: 'Legacy str task',
        metadata: { order: 0, task: 'true' },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Legacy str task \[todo\]/);
  });

  it('renders [done] badge when task is boolean true (regression)', () => {
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
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    // task:true is a marker but with no task.status object → falls back
    // to 'todo'. The legacy top-level status='done' is ignored (T3 fix).
    expect(out).toMatch(/Bool task \[todo\]/);
  });

  it('omits badge for false-like task values', () => {
    for (const task of [false, 0, 'false'] as const) {
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
      ] as any[];

      const out = formatProjectOutput({ project, children, truncated: false }, 200);
      expect(out).toMatch(new RegExp(`Task ${String(task)}`));
      expect(out).not.toMatch(new RegExp(`Task ${String(task)} \\[`));
    }
  });
});

describe('formatProjectOutput section block layout', () => {
  const project = {
    id: 'P1',
    metadata: { label: 'P1', kind: 'project' },
    title: 'P1 — x',
    content: '',
    tags: [],
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  it('renders section name on its own line with body below', () => {
    const section = {
      id: 'rules',
      parentId: 'P1',
      title: 'Rules',
      metadata: { order: 0 },
      tags: [],
      content: 'Always use MCP for DB',
      createdAt: '2026-06-01T00:00:00Z',
    } as any;

    const out = formatProjectOutput({ project, children: [section], truncated: false }, 200);
    expect(out).toMatch(/  Rules\n    Always use MCP for DB/);
  });

  it('shows No entries for empty section without children', () => {
    const section = {
      id: 'empty',
      parentId: 'P1',
      title: 'Ideas',
      metadata: { order: 0 },
      tags: [],
      content: '',
      createdAt: '2026-06-01T00:00:00Z',
    } as any;

    const out = formatProjectOutput({ project, children: [section], truncated: false }, 200);
    expect(out).toMatch(/  Ideas\n    No entries/);
  });

  it('skips section entirely when render_depth is 0', () => {
    const section = {
      id: 'hidden-kids',
      parentId: 'P1',
      title: 'Archive',
      metadata: { order: 0, render_depth: 0 },
      tags: [],
      content: 'section body',
      createdAt: '2026-06-01T00:00:00Z',
    } as any;

    const out = formatProjectOutput({ project, children: [section], truncated: false }, 200);
    expect(out).not.toContain('Archive');
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
