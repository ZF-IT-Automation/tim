import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TimStore,
  SessionManager,
  relateProjects,
  unrelateProjects,
  listRelatedProjects,
  setProjectDescription,
  formatRelatedProjectLine,
  collectNeighbourActivity,
  newestSubstantiveSession,
  RELATED_EDGE_TYPE,
  findChildByKind,
  KIND_SUMMARY_ROOT,
} from '../index.js';

describe('related projects', () => {
  let store: TimStore;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    await store.createProject('P0900', { content: 'Alpha | Active' });
    await store.createProject('P0901', { content: 'Beta | Active' });
    await store.createProject('P0902', { content: 'Gamma archived', metadata: { status: 'archived' } });
  });

  afterEach(() => store.close());

  it('relate links neighbours symmetrically in queries', async () => {
    expect(await relateProjects(store, 'P0900', 'P0901')).toBe('linked');
    const fromA = await listRelatedProjects(store, 'P0900');
    const fromB = await listRelatedProjects(store, 'P0901');
    expect(fromA.map(n => n.label)).toEqual(['P0901']);
    expect(fromB.map(n => n.label)).toEqual(['P0900']);
  });

  it('relate is no-op for duplicate edge either direction and for A==B', async () => {
    expect(await relateProjects(store, 'P0900', 'P0900')).toBe('noop-self');
    expect(await relateProjects(store, 'P0900', 'P0901')).toBe('linked');
    expect(await relateProjects(store, 'P0901', 'P0900')).toBe('noop-exists');
  });

  it('unrelate removes edge regardless of direction', async () => {
    await relateProjects(store, 'P0900', 'P0901');
    expect(await unrelateProjects(store, 'P0901', 'P0900')).toBe(true);
    expect(await listRelatedProjects(store, 'P0900')).toEqual([]);
  });

  it('unrelate removes both directed related edges between a pair', async () => {
    const a = await store.requireProject('P0900');
    const b = await store.requireProject('P0901');
    await store.link(a.id, b.id, RELATED_EDGE_TYPE);
    await store.link(b.id, a.id, RELATED_EDGE_TYPE);
    expect(await unrelateProjects(store, 'P0900', 'P0901')).toBe(true);
    const edges = await store.getEdges(a.id, 'both');
    expect(edges.filter(e => e.type === RELATED_EDGE_TYPE)).toHaveLength(0);
    expect(await listRelatedProjects(store, 'P0900')).toEqual([]);
  });

  it('hides archived neighbours', async () => {
    await relateProjects(store, 'P0900', 'P0902');
    expect(await listRelatedProjects(store, 'P0900')).toEqual([]);
  });

  it('describe sets metadata.description for briefing lines', async () => {
    await setProjectDescription(store, 'P0901', 'Companion tooling for Alpha.');
    await relateProjects(store, 'P0900', 'P0901');
    const line = formatRelatedProjectLine((await listRelatedProjects(store, 'P0900'))[0]!);
    expect(line).toContain('Companion tooling for Alpha.');
    expect(line).toContain('bind: false');
  });

  it('briefing line omits description when unset', async () => {
    await relateProjects(store, 'P0900', 'P0901');
    const line = formatRelatedProjectLine((await listRelatedProjects(store, 'P0900'))[0]!);
    expect(line).toMatch(/^P0901 — Beta/);
    expect(line).not.toContain('undefined');
  });
});

describe('newer neighbour handoffs', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0910', { content: 'Home' });
    await store.createProject('P0911', { content: 'Neighbour' });
    await relateProjects(store, 'P0910', 'P0911');
  });

  afterEach(() => store.close());

  async function substantiveSession(
    projectId: string,
    sessionId: string,
    date: string,
    note?: string,
    summary?: string,
  ) {
    await sessions.startProjectSession({
      sessionId,
      projectId,
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });
    await store.update(sessionId, { metadata: { date } });
    await sessions.logExchange(sessionId, [
      { role: 'user', content: 'one' },
      { role: 'agent', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'agent', content: 'four' },
      { role: 'user', content: 'five' },
      { role: 'agent', content: 'six' },
    ]);
    if (note) {
      await sessions.checkpoint(sessionId, {
        summarize: async () => 'stub',
        handoffNote: note,
      });
    }
    if (summary) await sessions.updateSessionSummary(sessionId, summary);
  }

  it('shows every newer neighbour session summary, not its handoff note', async () => {
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home note');
    await substantiveSession('P0911', 'nb-1', '2026-02-01T10:00:00.000Z', 'NB HANDOFF', 'first summary');
    await substantiveSession('P0911', 'nb-2', '2026-02-02T10:00:00.000Z', undefined, 'second summary');

    const out = await collectNeighbourActivity(store, 'P0910');
    expect(out).toHaveLength(1);
    expect(out[0]!.sessions.map(s => s.summary)).toEqual(['second summary', 'first summary']);
    expect(JSON.stringify(out)).not.toContain('NB HANDOFF');
  });

  it('skips neighbour sessions older than own newest substantive session', async () => {
    await substantiveSession('P0911', 'nb-old', '2026-01-01T10:00:00.000Z', undefined, 'old neighbour');
    await substantiveSession('P0910', 'home', '2026-02-01T10:00:00.000Z', 'home');
    await substantiveSession('P0911', 'nb-new', '2026-03-01T10:00:00.000Z', undefined, 'new neighbour');

    const out = await collectNeighbourActivity(store, 'P0910');
    expect(out[0]!.sessions.map(s => s.summary)).toEqual(['new neighbour']);
  });

  it('returns nothing without neighbours or without newer sessions', async () => {
    await store.createProject('P0912', { content: 'Solo' });
    await substantiveSession('P0912', 'solo', '2026-04-01T10:00:00.000Z', 'solo note');
    expect(await collectNeighbourActivity(store, 'P0912')).toEqual([]);

    await substantiveSession('P0911', 'nb', '2026-01-01T10:00:00.000Z', undefined, 'nb');
    await substantiveSession('P0910', 'home', '2026-02-01T10:00:00.000Z', 'home');
    expect(await collectNeighbourActivity(store, 'P0910')).toEqual([]);
  });

  it('caps at three summaries per neighbour with an overflow count', async () => {
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home');
    for (let i = 1; i <= 5; i++) {
      await substantiveSession('P0911', `nb-${i}`, `2026-02-0${i}T10:00:00.000Z`, undefined, `summary ${i}`);
    }
    const out = await collectNeighbourActivity(store, 'P0910');
    expect(out[0]!.sessions.map(s => s.summary)).toEqual(['summary 5', 'summary 4', 'summary 3']);
    expect(out[0]!.more).toBe(2);
  });

  it('counts newer sessions the summarizer has not reached yet', async () => {
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home');
    await substantiveSession('P0911', 'nb-raw-1', '2026-02-01T10:00:00.000Z');
    await substantiveSession('P0911', 'nb-raw-2', '2026-02-02T10:00:00.000Z');
    const out = await collectNeighbourActivity(store, 'P0910');
    expect(out[0]!.sessions).toEqual([]);
    expect(out[0]!.unsummarized).toBe(2);
  });

  it('excludes non-substantive neighbour sessions', async () => {
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home note');
    await sessions.startProjectSession({
      sessionId: 'nb-auto',
      projectId: 'P0911',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });
    await store.update('nb-auto', { metadata: { date: '2026-06-01T10:00:00.000Z' } });
    await sessions.logExchange('nb-auto', [
      { role: 'user', content: 'ping' },
      { role: 'agent', content: 'pong' },
    ]);
    const summaryNode = await findChildByKind(store, 'nb-auto', KIND_SUMMARY_ROOT);
    if (summaryNode) {
      await store.update(summaryNode.id, { metadata: { substance: 'none' } });
    }
    expect(await collectNeighbourActivity(store, 'P0910')).toEqual([]);
  });

  it('truncates long neighbour summaries', async () => {
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home');
    await substantiveSession('P0911', 'nb', '2026-02-01T10:00:00.000Z', undefined, 'x'.repeat(500));
    const out = await collectNeighbourActivity(store, 'P0910');
    expect(out[0]!.sessions[0]!.summary.length).toBeLessThanOrEqual(300);
    expect(out[0]!.sessions[0]!.summary.endsWith('…')).toBe(true);
  });

  it('picks the newest child checkpoint handoff when the summary root has no note', async () => {
    await substantiveSession('P0911', 'nb', '2026-02-01T10:00:00.000Z');
    const summaryNode = await findChildByKind(store, 'nb', KIND_SUMMARY_ROOT);
    expect(summaryNode).toBeTruthy();
    await store.update(summaryNode!.id, { metadata: { handoff_note: undefined } });
    const older = await store.write('older cp', {
      parentId: summaryNode!.id,
      metadata: { kind: 'checkpoint', handoff_note: 'FIRST note' },
    });
    const newer = await store.write('newer cp', {
      parentId: summaryNode!.id,
      metadata: { kind: 'checkpoint', handoff_note: 'SECOND note' },
    });
    await store.update(older.id, { updatedAt: '2026-01-01T10:00:00.000Z' });
    await store.update(newer.id, { updatedAt: '2026-02-01T10:00:00.000Z' });

    const head = await newestSubstantiveSession(store, 'P0911');
    expect(head?.handoffNote).toBe('SECOND note');
  });
});
