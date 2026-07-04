/**
 * Regression tests for the T3 badge fix.
 *
 * Pre-fix: `entryBadge` read `entry.metadata.status` (the legacy field).
 *          For an entry with `metadata.task = { status: 'done' }` and no
 *          `metadata.status`, the badge rendered as `[todo]` (fallback
 *          to the default) — making done tasks look open.
 *
 * Post-fix: the badge MUST read `entry.metadata.task.status` (the canonical
 *           task status). Legacy `metadata.status` is ignored — the fix
 *           is one-directional per Plan 7.
 *
 * These tests live at the new home of project-output.ts (tim-mcp), not
 * in tim-store, because the presentation code is moving to the MCP layer.
 */

import { describe, it, expect } from 'vitest';
import { formatProjectOutput } from '../project-output.js';

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

describe('formatProjectOutput task badge (T3 fix)', () => {
  it('reads metadata.task.status (canonical) for the badge label', () => {
    const children = [
      section,
      {
        id: 't-done',
        parentId: 'tasks',
        title: 'Done task',
        // NOTE: no legacy metadata.status — only the canonical task.status
        metadata: { order: 0, task: { status: 'done' } },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Done task \[done\]/);
    expect(out).not.toMatch(/Done task \[todo\]/);
  });

  it('renders [ ] for an explicit todo status (metadata.task.status=todo)', () => {
    const children = [
      section,
      {
        id: 't-todo',
        parentId: 'tasks',
        title: 'Open task',
        metadata: { order: 0, task: { status: 'todo' } },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Open task \[todo\]/);
  });

  it('renders [x] for metadata.task.status=done (the [x] alias)', () => {
    const children = [
      section,
      {
        id: 't-x',
        parentId: 'tasks',
        title: 'Completed task',
        metadata: { order: 0, task: { status: 'done' } },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    // The [x] in the spec is the user's shorthand for "done". The actual
    // badge text in the codebase is the status string itself, but we
    // also assert that the badge text equals 'done' to make the intent
    // explicit.
    expect(out).toMatch(/Completed task \[done\]/);
  });

  it('IGNORES legacy metadata.status (one-directional fix)', () => {
    // Legacy field present, but no metadata.task.status. The badge must
    // NOT pick up the legacy 'done' value — that would be the bug we
    // just fixed. The entry should fall back to [todo] default, NOT [done].
    const children = [
      section,
      {
        id: 't-legacy',
        parentId: 'tasks',
        title: 'Legacy status task',
        metadata: { order: 0, task: true, status: 'done' },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).not.toMatch(/Legacy status task \[done\]/);
    expect(out).toMatch(/Legacy status task \[todo\]/);
  });

  it('prefers metadata.task.status over legacy metadata.status when both present', () => {
    // Both fields present — the new canonical field wins. This documents
    // the priority order: task.status (canonical) > default fallback.
    const children = [
      section,
      {
        id: 't-both',
        parentId: 'tasks',
        title: 'Both fields task',
        metadata: {
          order: 0,
          task: { status: 'in_progress' },
          status: 'done', // legacy, must be ignored
        },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Both fields task \[in_progress\]/);
  });

  it('renders [todo] for task with no status field at all', () => {
    const children = [
      section,
      {
        id: 't-noop',
        parentId: 'tasks',
        title: 'Statusless task',
        metadata: { order: 0, task: true },
        tags: [],
        content: '',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ] as any[];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Statusless task \[todo\]/);
  });
});
