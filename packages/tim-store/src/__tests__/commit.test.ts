import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, CommitManager } from '../index.js';
import { KIND_COMMIT, KIND_COMMITS_ROOT } from '../commit-tree.js';
import { KIND_SESSION } from '../session-tree.js';

describe('CommitManager', () => {
  let store: TimStore;
  let commits: CommitManager;

  beforeEach(() => {
    store = new TimStore(':memory:');
    commits = new CommitManager(store);
  });

  afterEach(() => {
    store.close();
  });

  it('creates Commits section on first record', async () => {
    await store.createProject('P0002', { content: 'Test project' });

    await commits.recordCommit({
      projectId: 'P0002',
      hash: 'abc123def456',
      message: 'feat: first commit',
    });

    const project = await store.read('P0002');
    const sections = await store.getChildByKind(project!.id, KIND_COMMITS_ROOT);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('Commits');
  });

  it('writes hash as title and message + diff as body', async () => {
    await store.createProject('P0002', { content: 'Test project' });

    const entry = await commits.recordCommit({
      projectId: 'P0002',
      hash: 'deadbeef',
      message: 'fix: bug',
      diffSummary: ' src/a.ts | 2 ++\n 1 file changed',
    });

    expect(entry.title).toBe('deadbeef');
    expect(entry.content).toContain('fix: bug');
    expect(entry.content).toContain('src/a.ts');
    expect(entry.metadata.kind).toBe(KIND_COMMIT);
    expect(entry.metadata.commit_hash).toBe('deadbeef');
  });

  it('is idempotent for the same hash', async () => {
    await store.createProject('P0002', { content: 'Test project' });

    const first = await commits.recordCommit({
      projectId: 'P0002',
      hash: 'samehash',
      message: 'first',
    });
    const second = await commits.recordCommit({
      projectId: 'P0002',
      hash: 'samehash',
      message: 'ignored duplicate',
    });

    expect(second.id).toBe(first.id);
    const section = await commits.ensureCommitsSection('P0002');
    const all = await store.getChildByKind(section.id, KIND_COMMIT);
    expect(all).toHaveLength(1);
  });

  it('recordCommit accepts project alias', async () => {
    await store.createProject('P0048', { content: 'o9k', aliases: ['o9k'] });
    const entry = await commits.recordCommit({
      projectId: 'o9k',
      hash: 'aliashash',
      message: 'via alias',
    });
    expect(entry.metadata.kind).toBe(KIND_COMMIT);
    const project = await store.read('P0048');
    const section = await store.getChildByKind(project!.id, KIND_COMMITS_ROOT);
    expect(section).toHaveLength(1);
  });

  it('rejects nonexistent project', async () => {
    await expect(commits.recordCommit({
      projectId: 'P9999',
      hash: 'nope',
      message: 'x',
    })).rejects.toThrow(/Project not found: P9999/);
  });

  it('links commit and session via relates / implements', async () => {
    await store.createProject('P0002', { content: 'Test project' });
    const session = await store.write('Session test', {
      id: 'sess-commit',
      metadata: { kind: KIND_SESSION, sessionId: 'sess-commit' },
      tags: ['#session'],
    });

    const commit = await commits.recordCommit({
      projectId: 'P0002',
      hash: 'linkhash',
      message: 'feat: linked',
      sessionId: session.id,
    });

    const out = await store.getEdges(commit.id, 'outgoing');
    const inc = await store.getEdges(session.id, 'outgoing');
    expect(out.some(e => e.targetId === session.id && e.type === 'relates')).toBe(true);
    expect(inc.some(e => e.targetId === commit.id && e.type === 'implements')).toBe(true);
  });
});
