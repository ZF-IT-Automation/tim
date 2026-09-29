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
  });
});
