/**
 * B4 task/bug elevation (self-improving-loop iteration 4).
 *
 * - Task-bearing sections: open tasks first, done/cancelled collapsed
 * - Next Steps: only metadata.task children (no philosophy notes)
 * - Bugs: open bugs first with status/severity badges
 * - Bugs & Next Steps: higher child cap (no premature "… N more")
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

function section(id: string, title: string, order: number) {
  return {
    id,
    parentId: 'P1',
    title,
    metadata: { order },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;
}

function child(
  id: string,
  parentId: string,
  title: string,
  metadata: Record<string, unknown> = { order: 0 },
) {
  return {
    id,
    parentId,
    title,
    metadata,
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;
}

describe('formatProjectOutput task elevation (B4)', () => {
  it('sorts in_progress above todo in Tasks section', () => {
    const children = [
      section('tasks', 'Tasks', 0),
      child('t1', 'tasks', 'Todo item', { order: 0, task: { status: 'todo', priority: 'high' } }),
      child('t2', 'tasks', 'Active item', { order: 1, task: { status: 'in_progress', priority: 'low' } }),
    ];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    const activePos = out.indexOf('Active item [in_progress]');
    const todoPos = out.indexOf('Todo item [todo]');
    expect(activePos).toBeGreaterThan(-1);
    expect(todoPos).toBeGreaterThan(activePos);
  });

  it('collapses done/cancelled tasks with a summary line', () => {
    const children = [
      section('tasks', 'Tasks', 0),
      child('t1', 'tasks', 'Open task', { order: 0, task: { status: 'todo' } }),
      child('t2', 'tasks', 'Done task', { order: 1, task: { status: 'done' } }),
      child('t3', 'tasks', 'Cancelled task', { order: 2, task: { status: 'cancelled' } }),
    ];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Open task \[todo\]/);
    expect(out).not.toMatch(/Done task \[done\]/);
    expect(out).not.toMatch(/Cancelled task \[cancelled\]/);
    expect(out).toMatch(/2 completed tasks \(done\/cancelled\)/);
  });

  it('Next Steps shows only task-marked children', () => {
    const children = [
      section('next', 'Next Steps', 0),
      child('n1', 'next', 'Philosophy note', { order: 0 }),
      child('n2', 'next', 'Design spec', { order: 1, kind: 'note' }),
      child('n3', 'next', 'Real task', { order: 2, task: { status: 'todo' } }),
    ];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Real task \[todo\]/);
    expect(out).not.toMatch(/Philosophy note/);
    expect(out).not.toMatch(/Design spec/);
  });

  it('Next Steps hides done tasks and collapses them', () => {
    const children = [
      section('next', 'Next Steps', 0),
      child('n1', 'next', 'Active', { order: 0, task: { status: 'in_progress' } }),
      child('n2', 'next', 'Finished', { order: 1, task: { status: 'done' } }),
    ];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Active \[in_progress\]/);
    expect(out).not.toMatch(/Finished \[done\]/);
    expect(out).toMatch(/1 completed task \(done\/cancelled\)/);
  });
});

describe('formatProjectOutput bug elevation (B4)', () => {
  it('renders bug status and severity badges', () => {
    const children = [
      section('bugs', 'Bugs', 0),
      child('b1', 'bugs', 'Crash on load', {
        order: 0,
        bug: { status: 'open', severity: 'P0' },
        tags: ['#bug'],
      }),
    ];
    children[1].tags = ['#bug'];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).toMatch(/Crash on load \[open · P0\]/);
  });

  it('sorts open bugs before closed bugs', () => {
    const children = [
      section('bugs', 'Bugs', 0),
      child('b1', 'bugs', 'Old fixed bug', {
        order: 0,
        bug: { status: 'fixed', severity: 'P2' },
      }),
      child('b2', 'bugs', 'Urgent open bug', {
        order: 1,
        bug: { status: 'open', severity: 'P0' },
      }),
    ];
    children[1].tags = ['#bug'];
    children[2].tags = ['#bug'];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    const openPos = out.indexOf('Urgent open bug');
    const closedPos = out.indexOf('Old fixed bug');
    expect(openPos).toBeGreaterThan(-1);
    expect(closedPos).toBeGreaterThan(openPos);
  });
});

describe('formatProjectOutput protected section child cap (B4)', () => {
  it('does not truncate Next Steps at the default 10-child cap', () => {
    const children = [section('next', 'Next Steps', 0)];
    for (let i = 0; i < 15; i++) {
      children.push(child(`n${i}`, 'next', `Task ${i}`, { order: i, task: { status: 'todo' } }));
    }

    const out = formatProjectOutput({ project, children, truncated: false }, 500);
    expect(out).toMatch(/Task 14 \[todo\]/);
    expect(out).not.toMatch(/… \d+ more/);
  });

  it('does not truncate Bugs at the default 10-child cap', () => {
    const children = [section('bugs', 'Bugs', 0)];
    for (let i = 0; i < 12; i++) {
      const entry = child(`b${i}`, 'bugs', `Bug ${i}`, {
        order: i,
        bug: { status: 'open', severity: 'P2' },
      });
      entry.tags = ['#bug'];
      children.push(entry);
    }

    const out = formatProjectOutput({ project, children, truncated: false }, 500);
    expect(out).toMatch(/Bug 11 \[open · P2\]/);
    expect(out).not.toMatch(/… \d+ more/);
  });
});

describe('formatProjectOutput task/bug body previews (I6)', () => {
  it('renders a one-line task body preview below the task title', () => {
    const task = child('n1', 'next', 'Ship the renderer', {
      order: 0,
      task: { status: 'todo' },
    });
    task.content = 'Acceptance criteria:\nThe cold briefing exposes the done-when condition.';

    const out = formatProjectOutput({
      project,
      children: [section('next', 'Next Steps', 0), task],
      truncated: false,
    }, 200);

    expect(out).toContain(
      '    Ship the renderer [todo]\n'
      + '      Acceptance criteria: The cold briefing exposes the done-when condition.',
    );
  });

  it('normalizes and truncates a bug body preview to about 120 characters', () => {
    const bug = child('b1', 'bugs', 'Cold briefing loses context', {
      order: 0,
      bug: { status: 'open', severity: 'P1' },
    });
    bug.tags = ['#bug'];
    bug.content = [
      'Reproduction:',
      'Load a large project from a fresh agent and inspect whether actionable acceptance criteria are visible.',
      'This trailing sentence must not appear because the preview is deliberately compact.',
    ].join('\n');

    const out = formatProjectOutput({
      project,
      children: [section('bugs', 'Bugs', 0), bug],
      truncated: false,
    }, 200);

    expect(out).toContain(
      '    Cold briefing loses context [open · P1]\n'
      + '      Reproduction: Load a large project from a fresh agent and inspect whether actionable acceptance criteria are visible.…',
    );
    expect(out).not.toContain('This trailing sentence');
  });

  it('omits a preview line for a whitespace-only task body', () => {
    const task = child('t1', 'tasks', 'Empty task', {
      order: 0,
      task: { status: 'todo' },
    });
    task.content = ' \n\t ';

    const out = formatProjectOutput({
      project,
      children: [section('tasks', 'Tasks', 0), task],
      truncated: false,
    }, 200);

    expect(out).toContain('    Empty task [todo]');
    expect(out).not.toContain('    Empty task [todo]\n      ');
  });

  it('does not render body previews for ordinary child entries', () => {
    const note = child('n1', 'tasks', 'Implementation note', {
      order: 0,
      kind: 'note',
    });
    note.content = 'This ordinary note body must stay out of the compact child tree.';

    const out = formatProjectOutput({
      project,
      children: [section('tasks', 'Tasks', 0), note],
      truncated: false,
    }, 200);

    expect(out).toContain('    Implementation note');
    expect(out).not.toContain('This ordinary note body');
  });

  it('does not leak a preview from a child suppressed in load mode', () => {
    const task = child('n1', 'next', 'Read-only task', {
      order: 0,
      task: { status: 'todo' },
      renderDepthLoad: 0,
      renderDepthRead: 2,
    });
    task.content = 'Visible only when the node itself is rendered.';

    const out = formatProjectOutput({
      project,
      children: [section('next', 'Next Steps', 0), task],
      truncated: false,
    }, 200, undefined, 'load');

    expect(out).not.toContain('Read-only task');
    expect(out).not.toContain('Visible only when');
  });
});
