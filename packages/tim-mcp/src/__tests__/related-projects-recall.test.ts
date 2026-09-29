import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TimStore,
  SessionManager,
  relateProjects,
  setProjectDescription,
} from 'tim-store';
import { collectTopicResume, formatTopicResume } from '../topic-resume.js';
import { previewSessionStart } from 'tim-hooks';
import { buildBriefingRenderContext } from '../briefing-context.js';
import { formatProjectOutput } from '../project-output.js';

describe('cross-project topic resume', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0920', { content: 'Project A' });
    await store.createProject('P0921', { content: 'Game-Harness' });
    await relateProjects(store, 'P0920', 'P0921');
  });

  afterEach(() => store.close());

  async function seedTaggedSession(projectId: string, sessionId: string, tag: string, summary: string) {
    await sessions.startProjectSession({
      sessionId,
      projectId,
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
      batchSize: 2,
    });
    await store.update(sessionId, { metadata: { date: '2026-06-01T10:00:00.000Z' } });
    await sessions.logExchange(sessionId, [
      { role: 'user', content: 'q' },
      { role: 'agent', content: 'a' },
      { role: 'user', content: 'q2' },
      { role: 'agent', content: 'a2' },
    ]);
    await sessions.writeBatchSummary(sessionId, 1, summary, { seqFrom: 1, seqTo: 2 }, [tag]);
  }

  it('resume-topic in A finds B sessions tagged with project name', async () => {
    await seedTaggedSession('P0921', 'b-sess', '#jev', 'harness work on jev');
    const topic = await collectTopicResume(store, 'P0920', 'jev');
    expect(topic.sessions.some(s => s.summary.includes('harness work'))).toBe(true);
    expect(topic.sessions.find(s => s.summary.includes('harness work'))!.projectTag).toBe('Game-Harness');
    const text = formatTopicResume(topic);
    expect(text).toContain('[Game-Harness]');
  });

  it('resume-topic in B finds A sessions and vice versa is symmetric', async () => {
    await seedTaggedSession('P0920', 'a-sess', '#jev', 'alpha jev pass');
    const fromB = await collectTopicResume(store, 'P0921', 'jev');
    expect(fromB.sessions.some(s => s.summary.includes('alpha jev'))).toBe(true);
  });

  it('unrelated project unchanged', async () => {
    await store.createProject('P0922', { content: 'Lonely' });
    await seedTaggedSession('P0922', 'lonely', '#jev', 'isolated');
    const topic = await collectTopicResume(store, 'P0920', 'jev');
    expect(topic.sessions.some(s => s.summary.includes('isolated'))).toBe(false);
  });

  it('resume-topic without neighbours matches master-style session lines (no project tag)', async () => {
    await store.createProject('P0922', { content: 'Lonely' });
    await seedTaggedSession('P0922', 'lonely', '#jev', 'isolated work');
    const topic = await collectTopicResume(store, 'P0922', 'jev');
    const text = formatTopicResume(topic);
    expect(text).toContain('▸ 2026-06-01 10:00 · lonely');
    expect(text).not.toMatch(/▸ \[/);
  });

  it('session limit applies to merged own and neighbour sessions', async () => {
    await seedTaggedSession('P0920', 'a1', '#cap', 'alpha one');
    await seedTaggedSession('P0920', 'a2', '#cap', 'alpha two');
    await seedTaggedSession('P0921', 'b1', '#cap', 'beta one');
    const topic = await collectTopicResume(store, 'P0920', 'cap', 2);
    expect(topic.sessions).toHaveLength(2);
    expect(topic.sessionsMatched).toBeGreaterThan(2);
  });

  it('newest block uses neighbour session when it is the newest match', async () => {
    await seedTaggedSession('P0920', 'a-old', '#sync', 'older alpha');
    await store.update('a-old', { metadata: { date: '2026-01-01T10:00:00.000Z' } });
    await seedTaggedSession('P0921', 'b-new', '#sync', 'newer beta');
    await store.update('b-new', { metadata: { date: '2026-06-01T10:00:00.000Z' } });
    await sessions.checkpoint('b-new', {
      summarize: async () => 'stub',
      handoffNote: 'neighbour newest note',
    });
    const topic = await collectTopicResume(store, 'P0920', 'sync');
    expect(topic.newest?.sessionId).toBe('b-new');
    expect(topic.newest?.handoffNote).toBe('neighbour newest note');
  });

  it('tags work entries from a neighbour project', async () => {
    const nb = await store.requireProject('P0921');
    await store.write('Fix jev harness', {
      parentId: nb.id,
      metadata: { task: { status: 'in_progress' } },
    });
    const topic = await collectTopicResume(store, 'P0920', 'jev');
    const text = formatTopicResume(topic);
    expect(text).toContain('[Game-Harness] Fix jev harness');
  });

  it('hides archived neighbours in resume-topic', async () => {
    await store.createProject('P0922', { content: 'Gone', metadata: { status: 'archived' } });
    await relateProjects(store, 'P0920', 'P0922');
    await seedTaggedSession('P0922', 'arch', '#jev', 'archived neighbour');
    const topic = await collectTopicResume(store, 'P0920', 'jev');
    expect(topic.sessions.some(s => s.summary.includes('archived neighbour'))).toBe(false);
  });
});

describe('related project briefing surfaces', () => {
  let store: TimStore;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    await store.createProject('P0930', { content: 'Anchor' });
    await store.createProject('P0931', { content: 'Sidecar' });
    await setProjectDescription(store, 'P0931', 'Does side work.');
    await relateProjects(store, 'P0930', 'P0931');
  });

  afterEach(() => store.close());

  it('tim_load_project briefing lists neighbour with description', async () => {
    const project = await store.requireProject('P0930');
    const loaded = await store.loadProject('P0930', { depth: 1, budget: 50 });
    expect(loaded).not.toBeNull();
    const ctx = await buildBriefingRenderContext(store, 'P0930', project.id, 3);
    const out = formatProjectOutput(loaded!, 500, undefined, 'load', 3, {
      briefingContext: ctx,
      tokenBudget: 8000,
    });
    expect(out).toContain('── Related projects ──');
    expect(out).toContain('Does side work.');
    expect(out).toContain('P0931');
  });

  it('preview directive names neighbours', async () => {
    const preview = await previewSessionStart(store, {
      projectId: 'P0930',
      maxTokens: 4000,
      cwd: '/tmp',
    });
    expect(preview.directive).toContain('── Related projects ──');
    expect(preview.directive).toContain('Sidecar');
  });

  it('continue shows neighbour handoff only when neighbour is newer', async () => {
    const sessions = new SessionManager(store);
    async function substantive(projectId: string, sessionId: string, date: string, note: string) {
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
        { role: 'user', content: 'a' },
        { role: 'agent', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'agent', content: 'd' },
      ]);
      await sessions.checkpoint(sessionId, {
        summarize: async () => 'stub',
        handoffNote: note,
      });
    }
    await substantive('P0930', 'anchor', '2026-01-01T10:00:00.000Z', 'anchor handoff');
    await substantive('P0931', 'side', '2026-02-01T10:00:00.000Z', 'newer neighbour handoff');

    const preview = await previewSessionStart(store, {
      projectId: 'P0930',
      maxTokens: 8000,
      cwd: '/tmp',
    });
    expect(preview.directive).toContain('newer neighbour handoff');
    expect(preview.directive).toContain('P0931');
    expect(preview.directive).toContain('/tim-resume-topic <subject>');
  });

  it('continue preview omits neighbour handoff when neighbour is older', async () => {
    const sessions = new SessionManager(store);
    async function substantive(projectId: string, sessionId: string, date: string, note: string) {
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
        { role: 'user', content: 'a' },
        { role: 'agent', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'agent', content: 'd' },
      ]);
      await sessions.checkpoint(sessionId, {
        summarize: async () => 'stub',
        handoffNote: note,
      });
    }
    await substantive('P0931', 'side-old', '2026-01-01T10:00:00.000Z', 'stale neighbour');
    await substantive('P0930', 'anchor-new', '2026-03-01T10:00:00.000Z', 'fresh anchor');

    const preview = await previewSessionStart(store, {
      projectId: 'P0930',
      maxTokens: 8000,
      cwd: '/tmp',
    });
    expect(preview.directive).not.toContain('stale neighbour');
    expect(preview.directive).not.toContain('── Related project P0931');
  });

  it('hides archived neighbours in load-project briefing', async () => {
    await store.createProject('P0932', { content: 'Archived', metadata: { status: 'archived' } });
    await relateProjects(store, 'P0930', 'P0932');
    const project = await store.requireProject('P0930');
    const loaded = await store.loadProject('P0930', { depth: 1, budget: 50 });
    const ctx = await buildBriefingRenderContext(store, 'P0930', project.id, 3);
    const out = formatProjectOutput(loaded!, 500, undefined, 'load', 3, {
      briefingContext: ctx,
      tokenBudget: 8000,
    });
    expect(out).not.toContain('P0932');
  });
});
