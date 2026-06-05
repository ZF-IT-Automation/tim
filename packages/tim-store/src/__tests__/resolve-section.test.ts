import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

describe('resolveSectionByTitle', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('returns found when exactly one section matches', async () => {
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const section = await store.write('Tasks', { parentId: project.id });

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('found');
    if (r.status === 'found') {
      expect(r.id).toBe(section.id);
      expect(r.project).toBe('P0062');
      expect(r.title).toBe('Tasks');
    }
  });

  it('returns not_found with sibling section titles when zero matches', async () => {
    const project = await store.createProject('P0062', { content: 'bbbee' });
    await store.write('Tasks', { parentId: project.id });
    await store.write('Errors', { parentId: project.id });
    await store.write('Learnings', { parentId: project.id });

    const r = await store.resolveSectionByTitle('P0062', 'Decisions');
    expect(r.status).toBe('not_found');
    if (r.status === 'not_found') {
      expect(r.project).toBe('P0062');
      expect(r.title).toBe('Decisions');
      expect(r.candidates).toEqual(['Errors', 'Learnings', 'Tasks']);
    }
  });

  it('returns not_found with empty candidates when project has no sections', async () => {
    await store.createProject('P0062', { content: 'bbbee' });
    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('not_found');
    if (r.status === 'not_found') {
      expect(r.candidates).toEqual([]);
    }
  });

  it('returns ambiguous with full candidate list when multiple sections match', async () => {
    const project = await store.createProject('P0062', { content: 'bbbee' });
    // Simulate the real bug: an old hmem-imported Tasks section coexists
    // with the freshly-created one. Both are direct children of the project.
    const oldTasks = await store.write('Tasks', { parentId: project.id });
    const newTasks = await store.write('Tasks', { parentId: project.id });

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.project).toBe('P0062');
      expect(r.title).toBe('Tasks');
      expect(r.candidates).toHaveLength(2);
      const ids = r.candidates.map(c => c.id);
      expect(ids).toContain(oldTasks.id);
      expect(ids).toContain(newTasks.id);
      for (const c of r.candidates as Array<{ id: string; title: string; project: string; depth: number; createdAt: string }>) {
        expect(c.title).toBe('Tasks');
        expect(c.project).toBe('P0062');
        expect(c.depth).toBe(2);
        expect(typeof c.createdAt).toBe('string');
        expect(c.createdAt.length).toBeGreaterThan(0);
      }
    }
  });

  it('candidate order is created_at ascending (oldest first)', async () => {
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const first = await store.write('Tasks', { parentId: project.id });
    // Force a gap so the second write has a strictly later created_at.
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await store.write('Tasks', { parentId: project.id });

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates[0]!.id).toBe(first.id);
      expect(r.candidates[1]!.id).toBe(second.id);
    }
  });

  it('does NOT match sections from a different project', async () => {
    const p62 = await store.createProject('P0062', { content: 'bbbee' });
    const p63 = await store.createProject('P0063', { content: 'tim' });
    await store.write('Tasks', { parentId: p62.id });
    await store.write('Tasks', { parentId: p63.id });
    await store.write('Errors', { parentId: p63.id });

    // P0062 sees only its own single Tasks section.
    const r62 = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r62.status).toBe('found');
    if (r62.status === 'found') {
      // The id must be a direct child of P0062, not P0063.
      const p62Project = (await store.read('P0062'))!;
      const p63Project = (await store.read('P0063'))!;
      const childParent = store.getDb()
        .prepare('SELECT parent_id FROM entries WHERE id = ?')
        .get(r62.id) as { parent_id: string };
      expect(childParent.parent_id).toBe(p62Project.id);
      expect(childParent.parent_id).not.toBe(p63Project.id);
    }

    // P0063 lookup of 'Errors' returns found (sibling, not a Tasks collision).
    const r63 = await store.resolveSectionByTitle('P0063', 'Errors');
    expect(r63.status).toBe('found');

    // P0063 lookup of 'Bugs' (not present) returns not_found — and the
    // candidate list must only contain P0063 sections, not P0062's.
    const r63missing = await store.resolveSectionByTitle('P0063', 'Bugs');
    expect(r63missing.status).toBe('not_found');
    if (r63missing.status === 'not_found') {
      expect(r63missing.candidates).toEqual(['Errors', 'Tasks']);
    }

    // P0062 lookup of 'Bugs' also returns not_found — and lists P0062 sections.
    const r62missing = await store.resolveSectionByTitle('P0062', 'Bugs');
    expect(r62missing.status).toBe('not_found');
    if (r62missing.status === 'not_found') {
      expect(r62missing.candidates).toEqual(['Tasks']);
    }
  });

  it('ignores irrelevant (soft-deleted) sections', async () => {
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const live = await store.write('Tasks', { parentId: project.id });
    const dead = await store.write('Tasks', { parentId: project.id });
    // Mark dead as irrelevant via curate (update() refuses falsy flags).
    const curate = (store as any).curate?.();
    if (curate?.updateMany) {
      curate.updateMany([dead.id], { irrelevant: true });
    } else {
      // Fallback: direct DB write if curate is internal-only.
      store.getDb().prepare('UPDATE entries SET irrelevant = 1 WHERE id = ?').run(dead.id);
    }

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('found');
    if (r.status === 'found') {
      expect(r.id).toBe(live.id);
    }
  });

  it('returns not_found for unknown project', async () => {
    const r = await store.resolveSectionByTitle('NOPE', 'Tasks');
    expect(r.status).toBe('not_found');
  });

  it('resolves project by alias, not only direct label', async () => {
    const project = await store.createProject('P0062', {
      content: 'bbbee',
      aliases: ['pm'],
    });
    await store.write('Tasks', { parentId: project.id });

    const r = await store.resolveSectionByTitle('pm', 'Tasks');
    expect(r.status).toBe('found');
    if (r.status === 'found') {
      expect(r.project).toBe('P0062');
    }
  });

  it('does NOT include nested children (only direct children of project root)', async () => {
    const project = await store.createProject('P0062', { content: 'bbbee' });
    const tasks = await store.write('Tasks', { parentId: project.id });
    // A nested "Tasks" deeper in the tree must not be a section candidate.
    await store.write('Tasks', { parentId: tasks.id });

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('found');
    if (r.status === 'found') {
      expect(r.id).toBe(tasks.id);
    }
  });
});
