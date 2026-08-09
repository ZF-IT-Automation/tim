import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, CommitManager, SessionManager, findManagedRoot } from '../index.js';
import { KIND_COMMITS_ROOT } from '../commit-tree.js';
import { KIND_SESSIONS_ROOT } from '../session-tree.js';

// The failure this guards against: a project whose children were mass-flagged
// irrelevant (migration, bad bulk update) hides its managed roots from the
// `irrelevant = 0` lookup, so the next session or commit creates a second root
// next to the first. Repairing the flag afterwards leaves both — P0063 collected
// three "Commits" and two "Sessions" roots that way.
describe('findManagedRoot', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('reuses and un-hides a commits-root that was flagged irrelevant', async () => {
    await store.createProject('P0002', { content: 'Test project' });
    const commits = new CommitManager(store);

    const first = await commits.ensureCommitsSection('P0002');
    await store.delete(first.id); // soft delete = irrelevant, the flag in question

    const second = await commits.ensureCommitsSection('P0002');

    expect(second.id).toBe(first.id);
    expect(second.irrelevant).toBe(false);
    const project = await store.read('P0002');
    const roots = await store.getChildByKind(project!.id, KIND_COMMITS_ROOT, {
      includeIrrelevant: true,
    });
    expect(roots).toHaveLength(1);
  });

  it('reuses and un-hides a sessions-root that was flagged irrelevant', async () => {
    await store.createProject('P0002', { content: 'Test project' });
    const sessions = new SessionManager(store);

    await sessions.startProjectSession({
      sessionId: 'sess-one',
      projectId: 'P0002',
      agentName: 'test',
      cwd: '/tmp',
    });
    const project = await store.read('P0002');
    const [root] = await store.getChildByKind(project!.id, KIND_SESSIONS_ROOT);
    await store.delete(root!.id);

    await sessions.startProjectSession({
      sessionId: 'sess-two',
      projectId: 'P0002',
      agentName: 'test',
      cwd: '/tmp',
    });

    const roots = await store.getChildByKind(project!.id, KIND_SESSIONS_ROOT, {
      includeIrrelevant: true,
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.irrelevant).toBe(false);
  });

  it('returns null when no root exists at all', async () => {
    await store.createProject('P0002', { content: 'Test project' });
    const project = await store.read('P0002');
    expect(await findManagedRoot(store, project!.id, KIND_COMMITS_ROOT)).toBeNull();
  });
});
