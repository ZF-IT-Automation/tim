import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
