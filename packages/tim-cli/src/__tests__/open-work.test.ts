import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, setSecretSubtree } from 'tim-store';
import { collectOpenWork, readEntries } from '../open-work.js';

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

describe('readEntries', () => {
  let dbPath: string;
  let store: TimStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `tim-read-${Date.now()}.db`);
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
  });

  it('returns body with children, kind, status and project; hides secret children', async () => {
    const project = await store.write('Widget', {
      metadata: { kind: 'project', label: 'P0900', prefix: 'P', seq: 900 },
    });
    const task = await store.write('Why: it breaks.', {
      title: 'Fix the widget', parentId: project.id,
      tags: ['#widget'], metadata: { task: { status: 'todo', priority: 'P1' } },
    });
    await store.write('Patch the gear.', { title: 'Step one', parentId: task.id });
    const hidden = await store.write('hunter2', { title: 'Credentials', parentId: task.id });
    await setSecretSubtree(store, hidden.id);

    const [item] = await readEntries(store, [task.id]);
    expect(item).toMatchObject({
      id: task.id, title: 'Fix the widget', kind: 'task', status: 'todo',
      priority: 'P1', project: 'P0900', tags: ['#widget'], truncated: false,
    });
    expect('body' in item && item.body).toBe('Why: it breaks.\n\n## Step one\n\nPatch the gear.');
  });

  it('reports missing and secret ids instead of their text, and caps the body', async () => {
    const project = await store.write('Widget', {
      metadata: { kind: 'project', label: 'P0901', prefix: 'P', seq: 901 },
    });
    const secret = await store.write('key', { title: 'Vault', parentId: project.id });
    await setSecretSubtree(store, secret.id);
    const big = await store.write('x'.repeat(50), {
      title: 'Big bug', parentId: project.id, metadata: { bug: { status: 'open', severity: 'high' } },
    });

    const results = await readEntries(store, ['nope', secret.id, big.id], 10);
    expect(results[0]).toEqual({ id: 'nope', error: 'not_found' });
    expect(results[1]).toEqual({ id: secret.id, error: 'secret' });
    expect(results[2]).toMatchObject({ kind: 'bug', status: 'open', priority: 'high', body: 'x'.repeat(10), truncated: true });
  });
});
