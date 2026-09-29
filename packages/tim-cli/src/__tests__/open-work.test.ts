import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, setSecretSubtree } from 'tim-store';
import { collectOpenWork } from '../open-work.js';

describe('collectOpenWork', () => {
  let dbPath: string;
  let store: TimStore;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `tim-open-work-${Date.now()}.db`);
    store = new TimStore(dbPath);
    const project = await store.write('Widget', {
      metadata: { kind: 'project', label: 'P0900', prefix: 'P', seq: 900 },
    });
    const ideas = await store.write('Ideas', { parentId: project.id, metadata: { kind: 'section' } });
    await store.write('open task', {
      parentId: project.id, metadata: { task: { status: 'todo', priority: 'P1' } },
    });
    await store.write('done task', {
      parentId: project.id, metadata: { task: { status: 'done' } },
    });
    await store.write('open bug', { parentId: project.id, metadata: { bug: { status: 'open' } } });
    await store.write('fixed bug', { parentId: project.id, metadata: { bug: { status: 'fixed' } } });
    await store.write('fresh idea', { parentId: ideas.id, metadata: { idea: { status: 'new' } } });
    await store.write('dead idea', { parentId: ideas.id, metadata: { idea: { status: 'rejected' } } });
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
  });

  it('keeps open items of every kind and drops closed ones', async () => {
    const { items } = await collectOpenWork(store);
    expect(items.map(i => `${i.kind}:${i.title}`).sort()).toEqual([
      'bug:open bug', 'idea:fresh idea', 'task:open task',
    ]);
    expect(items.every(i => i.project === 'P0900')).toBe(true);
    expect(items.find(i => i.kind === 'task')?.priority).toBe('P1');
  });

  it('leaves out a secret entry', async () => {
    const before = await collectOpenWork(store);
    const bug = before.items.find(i => i.kind === 'bug')!;
    await setSecretSubtree(store, bug.id);
    const after = await collectOpenWork(store);
    expect(after.items.some(i => i.id === bug.id)).toBe(false);
  });
});
