// TIM Store — loadProject sections filter tests (Plan 1, Task 4)
//
// sections:['Tasks'] must match by section title (case-insensitive),
// not just by entry id or label.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('loadProject sections filter', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-sections-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('filters direct children by section title (case-insensitive)', async () => {
    const project = await store.createProject('P9002', { content: 'P9002 Test' });
    const tasks = await store.write('Tasks\n', { parentId: project.id });
    await store.write('Task one\ndo it', { parentId: tasks.id });
    await store.write('Ideas\n', { parentId: project.id });

    const result = await store.loadProject('P9002', { sections: ['tasks'] });
    expect(result).not.toBeNull();
    const titles = result!.children.map(c => c.title);
    expect(titles).toContain('Tasks');
    expect(titles).toContain('Task one');
    expect(titles).not.toContain('Ideas');
  });

  it('still matches by entry id', async () => {
    const project = await store.createProject('P9003', { content: 'P9003 Test' });
    const tasks = await store.write('Tasks\n', { parentId: project.id });
    await store.write('Ideas\n', { parentId: project.id });

    const result = await store.loadProject('P9003', { sections: [tasks.id] });
    expect(result!.children.map(c => c.title)).toEqual(expect.arrayContaining(['Tasks']));
    expect(result!.children.map(c => c.title)).not.toContain('Ideas');
  });
});