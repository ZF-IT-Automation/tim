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
});
