import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TimStore,
  SessionManager,
  KIND_SUMMARY_ROOT,
  SESSION_SUMMARY_TAG,
  findChildByKind,
} from '../index.js';

describe('SessionManager summary updates', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(() => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
  });

  it('updateSessionSummary creates summary-root with content', async () => {
    await store.createProject('P0099', { content: 'Test project' });
    const session = await sessions.startProjectSession({
      sessionId: 'sess-sum-1',
      projectId: 'P0099',
      agentName: 'agent',
      cwd: '/tmp',
      harness: 'test',
    });

    const updated = await sessions.updateSessionSummary('sess-sum-1', 'Checkpoint themes here');
    expect(updated.metadata.kind).toBe(KIND_SUMMARY_ROOT);
    expect(updated.content).toBe('Checkpoint themes here');
    expect(updated.tags).toContain(SESSION_SUMMARY_TAG);
    expect(updated.parentId).toBe(session.id);
  });

  it('updateSessionSummary upserts same node on repeat', async () => {
    await store.createProject('P0099', { content: 'Test project' });
    await sessions.startProjectSession({
      sessionId: 'sess-sum-2',
      projectId: 'P0099',
      agentName: 'agent',
      cwd: '/tmp',
      harness: 'test',
    });

    const first = await sessions.updateSessionSummary('sess-sum-2', 'First summary');
    const second = await sessions.updateSessionSummary('sess-sum-2', 'Second summary');

    expect(second.id).toBe(first.id);
    expect(second.content).toBe('Second summary');

    const summaryNode = await findChildByKind(store, 'sess-sum-2', KIND_SUMMARY_ROOT);
    const children = await store.getChildren(summaryNode!.id);
    expect(children.filter(c => c.metadata.kind === KIND_SUMMARY_ROOT)).toHaveLength(0);
  });

  it('updateProjectSummary writes entry count and last activity', async () => {
    const project = await store.createProject('P0100', {
      content: 'P0100 — Stats Test | Active\nBody.',
    });
    await store.write('Child A\nBody', { parentId: project.id, tags: ['#a', '#b'] });
    await new Promise(r => setTimeout(r, 5));
    await store.write('Child B\nBody', { parentId: project.id, tags: ['#a', '#b'] });

    const updated = await sessions.updateProjectSummary('P0100');
    expect(updated.content).toContain('2 entries · Last activity:');
    expect(updated.content).toContain('## Project Stats');
    expect(updated.content).toContain('Body.');
  });

  it('updateProjectSummary replaces stats block idempotently', async () => {
    const project = await store.createProject('P0101', { content: 'P0101 — Idempotent | Active' });
    await sessions.updateProjectSummary('P0101');
    await store.write('Extra\nx', { parentId: project.id, tags: ['#x', '#y'] });
    await sessions.updateProjectSummary('P0101');
    const twice = await store.read(project.id);
    const blocks = (twice!.content.match(/## Project Stats/g) ?? []).length;
    expect(blocks).toBe(1);
    expect(twice!.content).toContain('1 entries · Last activity:');
  });
});
