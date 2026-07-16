import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

describe('idea promote wired into updateSync', () => {
  let store: TimStore;
  let ideasSectionId: string;
  let tasksSectionId: string;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const ideas = await store.write('Ideas', { parentId: project.id });
    const tasks = await store.write('Tasks', { parentId: project.id });
    ideasSectionId = ideas.id;
    tasksSectionId = tasks.id;
  });

  afterEach(() => {
    store.close();
  });

  it('planned idea becomes task under Tasks with same id', async () => {
    const idea = await store.write('Brilliant thing', {
      parentId: ideasSectionId,
      metadata: { type: 'idea', idea: { status: 'new' } },
    });
    const updated = await store.update(idea.id, {
      metadata: { idea: { status: 'planned' } },
    });
    expect(updated.id).toBe(idea.id);
    expect(updated.metadata.idea).toBeUndefined();
    expect(updated.metadata.task).toMatchObject({ status: 'todo' });
    expect(updated.metadata.type).toBe('task');
    expect(updated.parentId).toBe(tasksSectionId);
  });

  it('already-task + idea.planned throws', async () => {
    const task = await store.write('Existing', {
      parentId: tasksSectionId,
      metadata: { type: 'task', task: { status: 'todo' } },
    });
    await expect(store.update(task.id, {
      metadata: { idea: { status: 'planned' } },
    })).rejects.toThrow(/already a task/i);
  });

  it('parked does not promote', async () => {
    const idea = await store.write('Park me', {
      parentId: ideasSectionId,
      metadata: { type: 'idea', idea: { status: 'new' } },
    });
    const updated = await store.update(idea.id, {
      metadata: { idea: { status: 'parked' } },
    });
    expect(updated.metadata.idea).toMatchObject({ status: 'parked' });
    expect(updated.metadata.task).toBeUndefined();
    expect(updated.parentId).toBe(ideasSectionId);
  });
});
