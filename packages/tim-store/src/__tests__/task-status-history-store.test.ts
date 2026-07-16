import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimStore } from '../store.js';

describe('task status history wired into updateSync', () => {
  let store: TimStore;
  let tasksSectionId: string;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const tasks = await store.write('Tasks', { parentId: project.id });
    tasksSectionId = tasks.id;
  });

  afterEach(() => {
    store.close();
  });

  it('appending status twice grows history; cache = last', async () => {
    const task = await store.write('Non-coding task', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo' } },
    });

    await store.update(task.id, { metadata: { task: { status: 'in_progress' } } });
    const updated = await store.update(task.id, { metadata: { task: { status: 'done' } } });

    const taskMeta = updated.metadata.task as { status: string; history: Array<{ status: string }> };
    expect(taskMeta.history).toHaveLength(3);
    expect(taskMeta.history.map((e) => e.status)).toEqual(['todo', 'in_progress', 'done']);
    expect(taskMeta.status).toBe('done');
  });

  it('coding done without reviewed throws', async () => {
    const task = await store.write('Coding task', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
    });

    await expect(
      store.update(task.id, { metadata: { task: { status: 'done' } } }),
    ).rejects.toThrow(/reviewed/i);
  });

  it('coding vcs none: reviewed then done ok without commits', async () => {
    const task = await store.write('Coding task, no vcs', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding', vcs: 'none' } },
    });

    await store.update(task.id, { metadata: { task: { status: 'reviewed' } } });
    const updated = await store.update(task.id, { metadata: { task: { status: 'done' } } });

    const taskMeta = updated.metadata.task as { status: string; history: Array<{ status: string }> };
    expect(taskMeta.status).toBe('done');
    expect(taskMeta.history.map((e) => e.status)).toEqual(['todo', 'reviewed', 'done']);
  });

  it('coding vcs git: done without pushed throws', async () => {
    const task = await store.write('Coding task, git', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding', vcs: 'git' } },
    });

    await store.update(task.id, { metadata: { task: { status: 'reviewed' } } });

    await expect(
      store.update(task.id, { metadata: { task: { status: 'done' } } }),
    ).rejects.toThrow(/pushed/i);
  });
});

describe('task.vcs auto-detection from projectPath', () => {
  let store: TimStore;
  let tasksSectionId: string;
  let repoRoot: string;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const tasks = await store.write('Tasks', { parentId: project.id });
    tasksSectionId = tasks.id;
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  });

  afterEach(() => {
    store.close();
  });

  it('write with projectPath in a repo sets vcs:git for a coding task', async () => {
    const task = await store.write('Coding task', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
      projectPath: repoRoot,
    });

    const taskMeta = task.metadata.task as { vcs?: string };
    expect(taskMeta.vcs).toBe('git');
  });

  it('write with projectPath outside a repo sets vcs:none for a coding task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tim-vcs-write-'));
    try {
      const task = await store.write('Coding task, no repo', {
        parentId: tasksSectionId,
        metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
        projectPath: dir,
      });

      const taskMeta = task.metadata.task as { vcs?: string };
      expect(taskMeta.vcs).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('first coding update with projectPath in a repo sets vcs:git', async () => {
    const task = await store.write('Coding task', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
    });

    const updated = await store.update(
      task.id,
      { metadata: { task: { status: 'in_progress' } } },
      { projectPath: repoRoot },
    );

    const taskMeta = updated.metadata.task as { vcs?: string };
    expect(taskMeta.vcs).toBe('git');
  });

  it('first coding update with projectPath outside a repo sets vcs:none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tim-vcs-update-'));
    try {
      const task = await store.write('Coding task, no repo', {
        parentId: tasksSectionId,
        metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
      });

      const updated = await store.update(
        task.id,
        { metadata: { task: { status: 'in_progress' } } },
        { projectPath: dir },
      );

      const taskMeta = updated.metadata.task as { vcs?: string };
      expect(taskMeta.vcs).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not override an already-set vcs', async () => {
    const task = await store.write('Coding task, vcs already set', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding', vcs: 'none' } },
    });

    const updated = await store.update(
      task.id,
      { metadata: { task: { status: 'in_progress' } } },
      { projectPath: repoRoot },
    );

    const taskMeta = updated.metadata.task as { vcs?: string };
    expect(taskMeta.vcs).toBe('none');
  });

  it('does not set vcs for non-coding tasks even with projectPath', async () => {
    const task = await store.write('Non-coding task', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo' } },
      projectPath: repoRoot,
    });

    const taskMeta = task.metadata.task as { vcs?: string };
    expect(taskMeta.vcs).toBeUndefined();
  });
});
