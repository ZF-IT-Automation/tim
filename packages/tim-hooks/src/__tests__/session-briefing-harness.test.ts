import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager, TimStore, findChildByKind } from 'tim-store';
import { collectDirectiveBriefing, recentExchanges } from '../session-briefing.js';

describe('recentExchanges harness folding (m1)', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0200');
    await sessions.startProjectSession({
      sessionId: 'brief-harness',
      projectId: 'P0200',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
  });

  afterEach(() => {
    store.close();
  });

  it('folds agent replies to harness-only users into the previous countable turn', async () => {
    await sessions.logExchange('brief-harness', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: '<task-notification>done</task-notification>' },
      { role: 'agent', content: 'Worker merged feature X' },
    ]);

    const blocks = await recentExchanges(store, 'brief-harness', 4000);
    const joined = blocks.join('\n');
    expect(joined).toContain('Q1');
    expect(joined).toContain('Worker merged feature X');
    expect(joined).not.toContain('task-notification');
  });
});

describe('latest handoff note on checkpoint children (m3)', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0201');
    await sessions.startProjectSession({
      sessionId: 'handoff-prev',
      projectId: 'P0201',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('handoff-prev', [
      { role: 'user', content: 'older session work' },
      { role: 'agent', content: 'done' },
      { role: 'user', content: 'more' },
      { role: 'agent', content: 'ok' },
    ]);
    await sessions.startProjectSession({
      sessionId: 'handoff-child',
      projectId: 'P0201',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
  });

  afterEach(() => {
    store.close();
  });

  it('picks the newest checkpoint child handoff note', async () => {
    const summaryNode = await findChildByKind(store, 'handoff-child', 'session-summary-root');
    expect(summaryNode).toBeTruthy();
    await store.write('cp1', {
      parentId: summaryNode!.id,
      metadata: { kind: 'checkpoint', handoff_note: 'older note' },
    });
    const cp2 = await store.write('cp2', {
      parentId: summaryNode!.id,
      metadata: { kind: 'checkpoint', handoff_note: 'newest note' },
    });
    await store.updateSync(cp2.id, { metadata: { kind: 'checkpoint', handoff_note: 'newest note' } });

    const briefing = await collectDirectiveBriefing(store, 'P0201', 8000, true);
    expect(briefing?.latestHandoffNote).toBe('newest note');
  });
});
