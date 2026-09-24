import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { formatOpenWorkLines } from '../session-briefing.js';

describe('formatOpenWorkLines stale handling', () => {
  let root: string;
  let store: TimStore;
  let sessionId: string;
  let workDays = 0;
  const staleIds: string[] = [];

  const setTouch = (id: string, iso: string) => store.getDb()
    .prepare("UPDATE entries SET created_at = ?, updated_at = ?, metadata = json_set(metadata, '$.touched_at', ?) WHERE id = ?")
    .run(iso, iso, iso, id);

  /** Log one exchange on a new project work day (day N of February). */
  const addWorkDay = async () => {
    workDays += 1;
    const ex = await store.write(`turn ${workDays}`, { parentId: sessionId, metadata: { kind: 'exchange' } });
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?')
      .run(`2026-02-${String(workDays).padStart(2, '0')}T10:00:00.000Z`, ex.id);
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-open-work-'));
    store = new TimStore(path.join(root, 'tim.db'));
    workDays = 0;
    staleIds.length = 0;
    const project = await store.createProject('P0099', { content: 'test' });
    const section = await store.write('Tasks', { parentId: project.id, metadata: { kind: 'section', order: 12 } });
    for (let i = 0; i < 5; i++) {
      const task = await store.write(`Stale task ${i}`, {
        parentId: section.id,
        metadata: { task: { status: 'todo', priority: 'medium' } },
      });
      // Stale task 0 is the oldest.
      setTouch(task.id, `2026-01-0${i + 1}T00:00:00.000Z`);
      staleIds.push(task.id);
    }
    await store.write('Fresh task', { parentId: section.id, metadata: { task: { status: 'todo', priority: 'high' } } });
    const sessionsRoot = await store.write('Sessions', { parentId: project.id, metadata: { kind: 'sessions-root' } });
    sessionId = (await store.write('s', { parentId: sessionsRoot.id, metadata: { kind: 'session' } })).id;
    for (let d = 0; d < 7; d++) await addWorkDay();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists fresh first, then one triage line, two stale previews with ids, and a count', async () => {
    const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
    expect(lines[0]).toContain('Fresh task');
    expect(lines[1]).toMatch(/^Stale = /);
    const previews = lines.filter(l => l.includes('Stale task'));
    expect(previews).toHaveLength(2);
    for (const l of previews) expect(l).toMatch(/· stale since 2026-01-0\d · \S+$/);
    expect(lines.some(l => l.startsWith('+ 3 stale open tasks'))).toBe(true);
  });

  it('rotates the preview each work day, so untriaged stale tasks all surface', async () => {
    const seen = new Set<string>();
    for (let day = 0; day < 10; day++) {
      const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
      for (const id of staleIds) if (lines.some(l => l.endsWith(id))) seen.add(id);
      await addWorkDay();
    }
    expect([...seen].sort()).toEqual([...staleIds].sort());
  });

  it('keeps rotating while the stale backlog grows by one task per work day', async () => {
    const tasksSection = (await store.read(staleIds[0]))!.parentId!;
    const seen = new Set<string>();
    for (let day = 0; day < 30; day++) {
      const extra = await store.write(`Late stale ${day}`, {
        parentId: tasksSection, metadata: { task: { status: 'todo', priority: 'low' } },
      });
      setTouch(extra.id, '2026-01-01T00:00:00.000Z');
      const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
      for (const id of staleIds) if (lines.some(l => l.endsWith(id))) seen.add(id);
      await addWorkDay();
    }
    expect([...seen].sort()).toEqual([...staleIds].sort());
  });

  it('a reorder is not a touch: the task stays stale', async () => {
    await store.setTaskOrder(staleIds[0]);
    const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
    expect(lines.some(l => l.startsWith('+ 3 stale open tasks') || l.endsWith(staleIds[0]))).toBe(true);
    expect(lines.filter(l => l.includes('Stale task') || l.startsWith('+ '))).not.toHaveLength(0);
    expect(lines.join('\n')).not.toMatch(/- \[todo, medium\] Stale task 0$/m);
  });

  it('a log record pointing at a task, or a child under it, keeps the task fresh', async () => {
    const log = await store.write('Worker log: progress on task 0', { metadata: { task: staleIds[0] } });
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run('2026-02-07T12:00:00.000Z', log.id);
    const child = await store.write('Subtask note', { parentId: staleIds[1] });
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run('2026-02-07T12:00:00.000Z', child.id);
    const lines = await formatOpenWorkLines(store, 'P0099', 12, 4000);
    expect(lines).toContain('- [todo, medium] Stale task 0');
    expect(lines).toContain('- [todo, medium] Stale task 1');
    expect(lines.some(l => l.startsWith('+ 1 stale open task') || l.includes('Stale task 2 ·'))).toBe(true);
  });

  it('keeps stale work visible when the budget is tight', async () => {
    const lines = await formatOpenWorkLines(store, 'P0099', 12, 700);
    expect(lines.join('\n')).toMatch(/Stale = |\+ 5 stale open tasks/);
  });

  it('counts fresh tasks that do not fit instead of dropping them', async () => {
    const lines = await formatOpenWorkLines(store, 'P0099', 0, 4000);
    expect(lines[0]).toBe('+ 1 more open task — tim_show({what:"tasks", root:"P0099"})');
  });
});
