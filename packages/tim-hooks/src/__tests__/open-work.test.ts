import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { formatOpenWorkLines } from '../session-briefing.js';

describe('formatOpenWorkLines stale collapse', () => {
  let root: string;
  let dbPath: string;
  let store: TimStore;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-open-work-'));
    dbPath = path.join(root, 'tim.db');
    store = new TimStore(dbPath);
    const project = await store.createProject('P0099', { content: 'test' });
    const section = await store.write('Tasks', {
      parentId: project.id,
      metadata: { kind: 'section', order: 12 },
    });

    const staleDate = '2026-01-01T00:00:00.000Z';
    for (let i = 0; i < 5; i++) {
      const task = await store.write(`Stale task ${i}`, {
        parentId: section.id,
        metadata: { task: { status: 'todo', priority: 'medium', order: (i + 1) * 100 } },
      });
      await store.update(task.id, { metadata: {} });
      store.getDb().prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(staleDate, task.id);
    }

    // Seven days of project work after the stale date, so the old tasks count as stale.
    const sessionsRoot = await store.write('Sessions', { parentId: project.id, metadata: { kind: 'sessions-root' } });
    const session = await store.write('s', { parentId: sessionsRoot.id, metadata: { kind: 'session' } });
    for (let d = 1; d <= 7; d++) {
      const ex = await store.write(`turn ${d}`, { parentId: session.id, metadata: { kind: 'exchange' } });
      store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?')
        .run(`2026-02-0${d}T10:00:00.000Z`, ex.id);
    }
    // Stale task 4 is the oldest, so rotation shows it first.
    const oldest = (await store.getTasks()).find(t => t.title === 'Stale task 4')!;
    store.getDb().prepare('UPDATE entries SET updated_at = ? WHERE id = ?')
      .run('2025-12-01T00:00:00.000Z', oldest.id);

    const fresh = await store.write('Fresh task', {
      parentId: section.id,
      metadata: { task: { status: 'todo', priority: 'high', order: 50 } },
    });
    store.getDb().prepare('UPDATE entries SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), fresh.id);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists fresh tasks first and collapses stale ones', async () => {
    const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
    expect(lines[0]).toContain('Fresh task');
    expect(lines[1]).toMatch(/^Stale = /);
    expect(lines[2]).toContain('Stale task 4');
    expect(lines.filter(l => l.includes('Stale task'))).toHaveLength(2);
    expect(lines.some(l => l.startsWith('+ 3 stale open tasks'))).toBe(true);
    expect(lines.join('\n')).toContain('tim_show({what:"tasks", root:"P0099"})');
  });

  it('counts fresh tasks that do not fit instead of dropping them', async () => {
    const lines = await formatOpenWorkLines(store, 'P0099', 0, 4000);
    expect(lines[0]).toBe('+ 1 more open task — tim_show({what:"tasks", root:"P0099"})');
  });

  it('shows three stale previews when all tasks are stale', async () => {
    const fresh = (await store.getTasks()).find(t => t.title === 'Fresh task');
    if (fresh) {
      await store.update(fresh.id, { metadata: { task: { status: 'done' } } });
    }
    const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
    expect(lines.filter(l => l.includes('Stale task'))).toHaveLength(3);
    expect(lines.some(l => l.startsWith('+ 2 stale open tasks'))).toBe(true);
  });
});
