import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TimStore,
  SessionManager,
  relateProjects,
  unrelateProjects,
  listRelatedProjects,
  setProjectDescription,
  formatRelatedProjectLine,
  findNewestSubstantiveSession,
  collectNewerNeighbourHandoffs,
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

  async function substantiveSession(projectId: string, sessionId: string, date: string, note?: string) {
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
    ]);
    if (note) {
      await sessions.checkpoint(sessionId, {
        summarize: async () => 'stub',
        handoffNote: note,
      });
    }
  }

  it('collectNewerNeighbourHandoffs includes neighbour only when newer', async () => {
    await substantiveSession('P0910', 'home-old', '2026-01-01T10:00:00.000Z', 'home note');
    await substantiveSession('P0911', 'nb-new', '2026-02-01T10:00:00.000Z', 'neighbour note');

    const blocks = await collectNewerNeighbourHandoffs(store, 'P0910', 200);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.handoffNote).toContain('neighbour note');

    const own = await findNewestSubstantiveSession(store, 'P0910');
    const theirs = await findNewestSubstantiveSession(store, 'P0911');
    expect(theirs!.lastActivity > own!.lastActivity).toBe(true);
  });

  it('skips neighbour when own substantive session is newer', async () => {
    await substantiveSession('P0911', 'nb-old', '2026-01-01T10:00:00.000Z', 'old neighbour');
    await substantiveSession('P0910', 'home-new', '2026-03-01T10:00:00.000Z', 'fresh home');

    const blocks = await collectNewerNeighbourHandoffs(store, 'P0910', 200);
    expect(blocks).toEqual([]);
  });

  it('returns no handoffs without listing neighbours when the project has none', async () => {
    await store.createProject('P0912', { content: 'Solo' });
    await substantiveSession('P0912', 'solo', '2026-04-01T10:00:00.000Z', 'solo note');
    const blocks = await collectNewerNeighbourHandoffs(store, 'P0912', 200);
    expect(blocks).toEqual([]);
  });

  it('ignores a newer non-substantive neighbour session for the comparison', async () => {
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
    const blocks = await collectNewerNeighbourHandoffs(store, 'P0910', 200);
    expect(blocks).toEqual([]);
  });

  it('orders neighbour handoffs by neighbour last activity', async () => {
    await store.createProject('P0913', { content: 'Third neighbour' });
    await relateProjects(store, 'P0910', 'P0913');
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home');
    await substantiveSession('P0911', 'nb-mid', '2026-02-15T10:00:00.000Z', 'mid neighbour');
    await substantiveSession('P0913', 'nb-new', '2026-03-20T10:00:00.000Z', 'newest neighbour');

    const blocks = await collectNewerNeighbourHandoffs(store, 'P0910', 200);
    expect(blocks.map(b => b.label)).toEqual(['P0913', 'P0911']);
  });

  it('truncates neighbour handoff notes to maxNoteChars', async () => {
    const long = 'x'.repeat(80);
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home');
    await substantiveSession('P0911', 'nb', '2026-02-01T10:00:00.000Z', long);
    const blocks = await collectNewerNeighbourHandoffs(store, 'P0910', 20);
    expect(blocks[0]!.handoffNote.length).toBeLessThanOrEqual(20);
    expect(blocks[0]!.handoffNote.endsWith('…')).toBe(true);
  });

  it('picks the newest child checkpoint handoff when the summary root has no note', async () => {
    await substantiveSession('P0910', 'home', '2026-01-01T10:00:00.000Z', 'home');
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
    const blocks = await collectNewerNeighbourHandoffs(store, 'P0910', 200);
    expect(blocks[0]!.handoffNote).toContain('SECOND note');
  });
});
