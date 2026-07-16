import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InProcessEventBus } from 'tim-core';
import { TimStore, SessionManager, deriveCounters, ensureInboxProject } from '../index.js';

describe('SessionManager', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(() => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
  });

  describe('sessionStart', () => {
    it('creates session entry with correct metadata', async () => {
      const entry = await sessions.sessionStart({
        sessionId: 'sess-001',
        agentName: 'cursor',
        cwd: '/tmp/project',
        harness: 'cursor',
      });

      expect(entry.id).toBe('sess-001');
      expect(entry.metadata.kind).toBe('session');
      expect(entry.metadata.agent).toBe('cursor');
      expect(entry.metadata.harness).toBe('cursor');
      expect(entry.metadata.cwd).toBe('/tmp/project');
    });

    it('is idempotent on repeat', async () => {
      const first = await sessions.sessionStart({
        sessionId: 'sess-002',
        agentName: 'claude',
        cwd: '/a',
        harness: 'claude-code',
      });
      const second = await sessions.sessionStart({
        sessionId: 'sess-002',
        agentName: 'other',
        cwd: '/b',
        harness: 'other',
      });

      expect(second.id).toBe(first.id);
      expect(second.metadata.agent).toBe('claude');
    });
  });

  describe('sessionLog', () => {
    it('creates child exchanges with monotonic seq and preserved roles', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-log',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });

      const batch1 = await sessions.sessionLog('sess-log', [
        { role: 'user', content: 'Hello' },
        { role: 'agent', content: 'Hi there' },
      ]);
      const batch2 = await sessions.sessionLog('sess-log', [
        { role: 'user', content: 'Bye' },
      ]);

      expect(batch1[0].metadata.seq).toBe(1);
      expect(batch1[1].metadata.seq).toBe(2);
      expect(batch2[0].metadata.seq).toBe(3);
      expect(batch1[0].metadata.role).toBe('user');
      expect(batch1[1].metadata.role).toBe('agent');
      expect(batch1[0].parentId).toBe('sess-log');
    });
  });

  describe('checkpoint', () => {
    it('creates summary, summarises edge, and calls summarizer in order', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-cp',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });
      await sessions.sessionLog('sess-cp', [
        { role: 'user', content: 'First' },
        { role: 'agent', content: 'Second' },
      ]);

      const received: string[] = [];
      const summarize = vi.fn(async (exchanges) => {
        for (const e of exchanges) {
          received.push(String(e.metadata.seq));
        }
        return 'summary text';
      });

      const summary = await sessions.checkpoint('sess-cp', { summarize, runDecay: false });

      expect(summary.metadata.kind).toBe('checkpoint');
      expect(summary.metadata.sessionId).toBe('sess-cp');
      expect(summary.metadata.count).toBe(2);
      expect(summarize).toHaveBeenCalledOnce();
      expect(received).toEqual(['1', '2']);

      const edges = await store.getEdges(summary.id, 'outgoing');
      expect(edges.some(e => e.type === 'summarizes' && e.targetId === 'sess-cp')).toBe(true);
    });

    it('stores handoff_note in checkpoint metadata when provided', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-handoff',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });
      await sessions.sessionLog('sess-handoff', [{ role: 'user', content: 'hi' }]);
      const summary = await sessions.checkpoint('sess-handoff', {
        handoffNote: 'done: x | wip: y | next: z',
      });
      expect(summary.metadata.handoff_note).toBe('done: x | wip: y | next: z');
    });

    it('runs decay only after summary is durable', async () => {
      const old = await store.write('old entry', {
        metadata: { kind: 'exchange' },
      });
      await new Promise(r => setTimeout(r, 5));

      await sessions.sessionStart({
        sessionId: 'sess-decay',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });
      await sessions.sessionLog('sess-decay', [
        { role: 'user', content: 'msg' },
      ]);

      const summary = await sessions.checkpoint('sess-decay', { runDecay: true });

      const oldRead = await store.read(old.id, { showIrrelevant: true });
      expect(oldRead?.irrelevant).toBe(true);

      const sessionRead = await store.read('sess-decay');
      const summaryRead = await store.read(summary.id);
      expect(sessionRead).not.toBeNull();
      expect(summaryRead).not.toBeNull();
    });

    it('uses default summarizer producing thematic summary, truncated at 2000 chars', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-stub',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });
      // Large inputs to trigger 2000-char truncation in thematic summary
      await sessions.sessionLog('sess-stub', [
        { role: 'user', content: 'A'.repeat(800) },
        { role: 'agent', content: 'B'.repeat(800) },
        { role: 'user', content: 'C'.repeat(800) },
      ]);

      const summary = await sessions.checkpoint('sess-stub', { runDecay: false });
      expect(summary.title).toContain('Session checkpoint');
      expect(summary.content).toContain('Topics:');
      // Must be thematic, not raw "user: ..." dump
      expect(summary.content).not.toMatch(/^user:/m);
      // Total length respects 2000 char bound
      const full = (summary.title + '\n' + (summary.content || ''));
      expect(full.length).toBeLessThanOrEqual(2001);
    });

    it('does not run decay if summary write fails', async () => {
      const old = await store.write('protected old');
      await new Promise(r => setTimeout(r, 5));

      await sessions.sessionStart({
        sessionId: 'sess-fail',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });
      await sessions.sessionLog('sess-fail', [
        { role: 'user', content: 'msg' },
      ]);

      const decaySpy = vi.spyOn(store, 'runDecay');
      const writeSpy = vi.spyOn(store, 'write');
      writeSpy.mockImplementationOnce(async () => {
        throw new Error('write failed');
      });

      await expect(
        sessions.checkpoint('sess-fail', { summarize: async () => 'x' }),
      ).rejects.toThrow('write failed');

      expect(decaySpy).not.toHaveBeenCalled();

      const oldRead = await store.read(old.id);
      expect(oldRead).not.toBeNull();

      writeSpy.mockRestore();
      decaySpy.mockRestore();
    });
  });

  describe('integration: full session lifecycle', () => {
    it('start → log → checkpoint with events in order', async () => {
      const bus = new InProcessEventBus();
      const events: string[] = [];
      bus.on('memory:written', () => { events.push('memory:written'); });
      bus.on('edge:created', () => { events.push('edge:created'); });

      const eventStore = new TimStore(':memory:', { emitter: bus });
      const eventSessions = new SessionManager(eventStore);

      const old = await eventStore.write('stale data', { metadata: { kind: 'exchange' } });
      await new Promise(r => setTimeout(r, 5));

      await eventSessions.sessionStart({
        sessionId: 'lifecycle',
        agentName: 'test-agent',
        cwd: '/proj',
        harness: 'vitest',
      });
      await eventSessions.sessionLog('lifecycle', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
      ]);

      const summary = await eventSessions.checkpoint('lifecycle', { runDecay: true });

      expect(events.filter(e => e === 'memory:written').length).toBeGreaterThanOrEqual(5);
      expect(events).toContain('edge:created');

      const exchanges = await eventSessions.getSessionExchanges('lifecycle');
      expect(exchanges).toHaveLength(3);

      const stale = await eventStore.read(old.id, { showIrrelevant: true });
      expect(stale?.irrelevant).toBe(true);
      expect(await eventStore.read('lifecycle')).not.toBeNull();
      expect(await eventStore.read(summary.id)).not.toBeNull();

      eventStore.close();
    });
  });

  describe('deriveCounters', () => {
    it('returns zeros for a session with no Exchanges/Summary nodes', async () => {
      const s = await store.write('bare', { id: 'bare-sess', metadata: { kind: 'session' } });
      const c = await deriveCounters(store, s.id);
      expect(c).toEqual({ exchangeCount: 0, batchesSummarized: 0 });
    });

    it('counts user exchanges per batch, skips empty trailing batch', async () => {
      await store.createProject('P0093');
      await sessions.startProjectSession({
        sessionId: 'dc',
        projectId: 'P0093',
        agentName: 'a',
        cwd: '/',
        harness: 't',
        batchSize: 2,
      });

      expect(await deriveCounters(store, 'dc')).toEqual({
        exchangeCount: 0,
        batchesSummarized: 0,
      });

      await sessions.logExchange('dc', [{ role: 'user', content: 'Q1' }]);
      expect(await deriveCounters(store, 'dc')).toEqual({
        exchangeCount: 1,
        batchesSummarized: 0,
      });

      await sessions.logExchange('dc', [
        { role: 'user', content: 'Q2' },
        { role: 'user', content: 'Q3' },
      ]);
      expect(await deriveCounters(store, 'dc')).toEqual({
        exchangeCount: 3,
        batchesSummarized: 0,
      });

      const summaryNode = (await store.getChildByKind('dc', 'session-summary-root'))[0];
      await store.write('Batch 1', {
        parentId: summaryNode.id,
        metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 2 },
      });
      expect(await deriveCounters(store, 'dc')).toEqual({
        exchangeCount: 3,
        batchesSummarized: 1,
      });
    });
  });

  describe('ensureInboxProject', () => {
    it('creates P0000 Inbox system project once', async () => {
      const first = await ensureInboxProject(store);
      const second = await ensureInboxProject(store);
      expect(first.metadata.label).toBe('P0000');
      expect(first.metadata.is_system).toBe(true);
      expect(first.title).toBe('Inbox');
      expect(second.id).toBe(first.id);
    });

    it.each([
      { shape: 'missing kind', metadata: { label: 'N0000' } },
      { shape: 'wrong kind and label', metadata: { kind: 'note', label: 'N0000' } },
    ])('repairs P0000 with $shape without losing user data and stages once', async ({ metadata }) => {
      await store.write('Custom Inbox\nKeep this content', {
        id: 'P0000',
        tags: ['#custom', '#project'],
        metadata: {
          ...metadata,
          custom: 'preserved',
          is_system: false,
          render_depth: 4,
        },
      });
      store.getDb().prepare(
        `UPDATE entries SET irrelevant = 1, tombstoned_at = '2026-01-01T00:00:00.000Z'
         WHERE id = 'P0000'`,
      ).run();
      store.getDb().prepare('DELETE FROM staging').run();

      const repaired = await ensureInboxProject(store);
      const repeated = await ensureInboxProject(store);

      expect(repaired).toMatchObject({
        id: 'P0000',
        title: 'Custom Inbox',
        content: 'Keep this content',
        irrelevant: false,
        tombstonedAt: null,
      });
      expect(repaired.metadata).toMatchObject({
        kind: 'project',
        label: 'P0000',
        is_system: true,
        render_depth: 1,
        custom: 'preserved',
      });
      expect(repaired.tags).toEqual(expect.arrayContaining([
        '#custom', '#project', '#inbox', '#system',
      ]));
      expect(repeated).toEqual(repaired);
      expect(await store.getStaging()).toHaveLength(1);
      const session = await sessions.startProjectSession({
        sessionId: 'inbox-repair-session',
        projectId: 'P0000',
        agentName: 'test',
        cwd: '/tmp',
        harness: 'test',
      });
      expect(session.metadata.project_ref).toBe('P0000');
      const rowCount = store.getDb().prepare(
        `SELECT COUNT(*) AS count FROM entries WHERE id = 'P0000'`,
      ).get() as { count: number };
      expect(rowCount.count).toBe(1);
    });

    it('canonicalizes a logical P0000 stored under a different id without losing data or edges', async () => {
      const legacy = await store.write('Legacy Inbox\nPreserve this body', {
        id: 'LEGACY-INBOX-ID',
        tags: ['#custom'],
        metadata: {
          kind: 'project',
          label: 'P0000',
          custom: { owner: 'user' },
        },
      });
      const child = await store.write('Legacy child', { parentId: legacy.id });
      const target = await store.write('Edge target');
      await store.link(legacy.id, target.id, 'relates', 0.75, { custom: 'edge' });
      store.getDb().prepare('DELETE FROM staging').run();

      const repaired = await ensureInboxProject(store);

      expect(repaired).toMatchObject({
        id: 'P0000',
        title: 'Legacy Inbox',
        content: 'Preserve this body',
      });
      expect(repaired.metadata).toMatchObject({
        kind: 'project',
        label: 'P0000',
        is_system: true,
        render_depth: 1,
        custom: { owner: 'user' },
      });
      expect(repaired.tags).toEqual(expect.arrayContaining([
        '#custom', '#project', '#inbox', '#system',
      ]));
      expect(await store.read('LEGACY-INBOX-ID')).toBeNull();
      expect((await store.read(child.id))?.parentId).toBe('P0000');
      expect(await store.getEdges('P0000', 'outgoing')).toEqual([
        expect.objectContaining({ targetId: target.id, weight: 0.75, metadata: { custom: 'edge' } }),
      ]);
      const logicalRows = store.getDb().prepare(
        `SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0000'`,
      ).all() as Array<{ id: string }>;
      expect(logicalRows).toEqual([{ id: 'P0000' }]);
      expect(await store.getStaging()).toHaveLength(1);
    });

    it('merges a duplicate logical Inbox into an existing physical P0000', async () => {
      await store.write('Canonical Inbox\nCanonical body', {
        id: 'P0000',
        tags: ['#canonical'],
        metadata: { kind: 'note', label: 'WRONG', canonical_custom: true },
      });
      const duplicate = await store.write('Duplicate Inbox\nDuplicate body', {
        id: 'LEGACY-INBOX-DUPLICATE',
        tags: ['#legacy'],
        metadata: { kind: 'project', label: 'P0000', legacy_custom: { keep: true } },
      });
      const target = await store.write('Edge target');
      await store.link(duplicate.id, target.id, 'relates');
      store.getDb().prepare('DELETE FROM staging').run();

      const repaired = await ensureInboxProject(store);

      expect(repaired.id).toBe('P0000');
      expect(repaired.content).toContain('Canonical body');
      expect(repaired.content).toContain('Duplicate body');
      expect(repaired.metadata).toMatchObject({
        kind: 'project',
        label: 'P0000',
        canonical_custom: true,
        legacy_custom: { keep: true },
      });
      expect(repaired.metadata.merged_inbox_entries).toEqual([
        expect.objectContaining({
          id: 'LEGACY-INBOX-DUPLICATE',
          title: 'Duplicate Inbox',
          content: 'Duplicate body',
          metadata: expect.objectContaining({ legacy_custom: { keep: true } }),
        }),
      ]);
      expect(repaired.tags).toEqual(expect.arrayContaining(['#canonical', '#legacy']));
      expect(await store.read('LEGACY-INBOX-DUPLICATE')).toBeNull();
      expect(await store.getEdges('P0000', 'outgoing')).toEqual([
        expect.objectContaining({ targetId: target.id }),
      ]);
      const logicalRows = store.getDb().prepare(
        `SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0000'`,
      ).all() as Array<{ id: string }>;
      expect(logicalRows).toEqual([{ id: 'P0000' }]);
      expect(await store.getStaging()).toHaveLength(1);
    });

    it('rolls back a repair when sync staging fails', async () => {
      await store.write('User Inbox\nDo not lose', {
        id: 'P0000',
        tags: ['#custom'],
        metadata: { kind: 'note', label: 'N0000', custom: 'preserved' },
      });
      store.getDb().prepare(
        `UPDATE entries SET irrelevant = 1, tombstoned_at = '2026-01-01T00:00:00.000Z'
         WHERE id = 'P0000'`,
      ).run();
      store.getDb().prepare('DELETE FROM staging').run();

      const internals = store as unknown as {
        insertStagingSync: (...args: unknown[]) => void;
      };
      const original = internals.insertStagingSync.bind(store);
      internals.insertStagingSync = () => { throw new Error('staging boom'); };

      await expect(ensureInboxProject(store)).rejects.toThrow('staging boom');
      internals.insertStagingSync = original;

      const row = store.getDb().prepare(
        `SELECT title, content, tags, irrelevant, tombstoned_at, metadata
         FROM entries WHERE id = 'P0000'`,
      ).get() as Record<string, unknown>;
      expect(row).toMatchObject({
        title: 'User Inbox',
        content: 'Do not lose',
        irrelevant: 1,
        tombstoned_at: '2026-01-01T00:00:00.000Z',
      });
      expect(JSON.parse(row.metadata as string)).toMatchObject({
        kind: 'note', label: 'N0000', custom: 'preserved',
      });
      expect(await store.getStaging()).toHaveLength(0);
    });
  });

  describe('startProjectSession', () => {
    it('creates Sessions section + session node + Summary + Exchanges', async () => {
      await store.createProject('P0099');
      const session = await sessions.startProjectSession({
        sessionId: 'sess-proj-1',
        projectId: 'P0099',
        agentName: 'claude',
        cwd: '/p',
        harness: 'claude-code',
      });

      expect(session.id).toBe('sess-proj-1');
      expect(session.metadata.kind).toBe('session');
      expect(session.metadata.project_ref).toBe('P0099');
      expect(session.metadata.batch_size).toBe(5);

      const project = await store.read('P0099');
      const sectionKids = await store.getChildByKind(project!.id, 'sessions-root');
      expect(sectionKids).toHaveLength(1);
      expect(sectionKids[0].metadata.order).toBe(1000);

      expect(session.parentId).toBe(sectionKids[0].id);

      const summary = await store.getChildByKind(session.id, 'session-summary-root');
      const exchanges = await store.getChildByKind(session.id, 'exchanges-root');
      expect(summary).toHaveLength(1);
      expect(exchanges).toHaveLength(1);
      expect(summary[0].tags).toContain('#session-summary');

      const batches = await store.getChildByKind(exchanges[0].id, 'exchange-batch');
      expect(batches).toHaveLength(1);
      expect(batches[0].title).toBe('Batch 1');
      expect(batches[0].metadata.batch_index).toBe(1);
    });

    it('accepts project alias as projectId', async () => {
      await store.createProject('P0048', { content: 'o9k', aliases: ['o9k'] });
      const session = await sessions.startProjectSession({
        sessionId: 'sess-alias',
        projectId: 'o9k',
        agentName: 'cursor',
        cwd: '/p',
        harness: 'cursor',
      });
      expect(session.metadata.project_ref).toBe('o9k');
      const project = await store.requireProject('o9k');
      expect(project.metadata.label).toBe('P0048');
    });

    it('startProjectSession throws with candidates when alias is ambiguous', async () => {
      await store.createProject('PA1', { content: 'a1', aliases: ['shared'] });
      await store.createProject('PA2', { content: 'a2', aliases: ['shared'] });
      await expect(sessions.startProjectSession({
        sessionId: 'sess-amb',
        projectId: 'shared',
        agentName: 'test',
        cwd: '/tmp',
        harness: 'test',
      })).rejects.toThrow(/PA1.*PA2|PA2.*PA1/);
    });

    it('is idempotent and reuses the Sessions section across sessions', async () => {
      await store.createProject('P0098');
      await sessions.startProjectSession({
        sessionId: 's1',
        projectId: 'P0098',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      await sessions.startProjectSession({
        sessionId: 's1',
        projectId: 'P0098',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      await sessions.startProjectSession({
        sessionId: 's2',
        projectId: 'P0098',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });

      const project = await store.read('P0098');
      const sections = await store.getChildByKind(project!.id, 'sessions-root');
      expect(sections).toHaveLength(1);
      const sessionNodes = await store.getChildByKind(sections[0].id, 'session');
      expect(sessionNodes.map(s => s.id).sort()).toEqual(['s1', 's2']);
    });

    it('updates project_ref when rebinding an existing session to another project', async () => {
      await store.createProject('P0096');
      await store.createProject('P0095');
      await sessions.startProjectSession({
        sessionId: 'rebind-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      const rebound = await sessions.startProjectSession({
        sessionId: 'rebind-s',
        projectId: 'P0095',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      expect(rebound.metadata.project_ref).toBe('P0095');

      const back = await sessions.startProjectSession({
        sessionId: 'rebind-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      expect(back.metadata.project_ref).toBe('P0096');
      const p0096b = await store.read('P0096');
      const sec96 = (await store.getChildByKind(p0096b!.id, 'sessions-root'))[0];
      expect(back.parentId).toBe(sec96.id);

      const noop = await sessions.startProjectSession({
        sessionId: 'rebind-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      expect(noop.parentId).toBe(sec96.id);
    });

    it('reparents the session node + its exchanges to the new project on switch', async () => {
      await store.createProject('P0096');
      await store.createProject('P0095');

      await sessions.startProjectSession({
        sessionId: 'switch-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      await sessions.logExchange('switch-s', [
        { role: 'user', content: 'first question' },
        { role: 'agent', content: 'first answer' },
      ]);

      const exBefore = await sessions.getSessionExchanges('switch-s');
      const userExchangeId = exBefore.find(e => e.metadata.role === 'user')!.id;

      const rebound = await sessions.startProjectSession({
        sessionId: 'switch-s',
        projectId: 'P0095',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });

      expect(rebound.metadata.project_ref).toBe('P0095');

      const p0095 = await store.read('P0095');
      const newSection = (await store.getChildByKind(p0095!.id, 'sessions-root'))[0];
      expect(rebound.parentId).toBe(newSection.id);
      const movedNodes = await store.getChildByKind(newSection.id, 'session');
      expect(movedNodes.map(s => s.id)).toContain('switch-s');

      const p0096 = await store.read('P0096');
      const oldSections = await store.getChildByKind(p0096!.id, 'sessions-root');
      const oldSessionIds = oldSections.length
        ? (await store.getChildByKind(oldSections[0].id, 'session')).map(s => s.id)
        : [];
      expect(oldSessionIds).not.toContain('switch-s');

      const movedExchange = await store.read(userExchangeId);
      expect(movedExchange!.content || movedExchange!.title).toContain('first question');
      const kids = await store.getChildren(newSection.id);
      const sessionChild = kids.find(k => k.id === 'switch-s');
      expect(sessionChild!.metadata.project_ref).toBe('P0095');
    });

    it('binds unbound sessions to P0000 Inbox when using inbox helper', async () => {
      await ensureInboxProject(store);
      const session = await sessions.startProjectSession({
        sessionId: 'inbox-sess',
        projectId: 'P0000',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      expect(session.metadata.project_ref).toBe('P0000');
    });
  });

  describe('logExchange (nested)', () => {
    beforeEach(async () => {
      await store.createProject('P0097');
      await sessions.startProjectSession({
        sessionId: 'sx',
        projectId: 'P0097',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
    });

    it('nests agent reply under its user message and seqs only user nodes', async () => {
      await sessions.logExchange('sx', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'agent', content: 'A2' },
      ]);

      const exNode = (await store.getChildByKind('sx', 'exchanges-root'))[0];
      const batches = await store.getChildByKind(exNode.id, 'exchange-batch');
      expect(batches).toHaveLength(1);
      expect(batches[0].title).toBe('Batch 1');

      const users = (await store.getChildrenBySeq(batches[0].id)).filter(
        u => u.metadata.role === 'user',
      );
      expect(users.map(u => [u.title, u.metadata.seq, u.metadata.role])).toEqual([
        ['Q1', 1, 'user'],
        ['Q2', 2, 'user'],
      ]);

      const a1 = await store.getChildren(users[0].id);
      expect(a1).toHaveLength(1);
      expect(a1[0].title).toBe('A1');
      expect(a1[0].metadata.role).toBe('agent');
      expect(a1[0].metadata.seq).toBe(1);
    });

    it('continues seq across calls and updates the cached exchange_count', async () => {
      await sessions.logExchange('sx', [{ role: 'user', content: 'first' }]);
      await sessions.logExchange('sx', [{ role: 'user', content: 'second' }]);

      const exNode = (await store.getChildByKind('sx', 'exchanges-root'))[0];
      const batch = (await store.getChildByKind(exNode.id, 'exchange-batch'))[0];
      const users = (await store.getChildrenBySeq(batch.id)).filter(
        u => u.metadata.role === 'user',
      );
      expect(users.map(u => u.metadata.seq)).toEqual([1, 2]);

      const session = await store.read('sx');
      expect(session!.metadata.exchange_count).toBe(2);
    });

    it('splits into a new exchange-batch when batch_size is reached', async () => {
      await sessions.startProjectSession({
        sessionId: 'sx-split',
        projectId: 'P0097',
        agentName: 'a',
        cwd: '/',
        harness: 't',
        batchSize: 2,
      });
      await sessions.logExchange('sx-split', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'agent', content: 'A2' },
        { role: 'user', content: 'Q3' },
        { role: 'agent', content: 'A3' },
      ]);

      const exNode = (await store.getChildByKind('sx-split', 'exchanges-root'))[0];
      const batches = await store.getChildByKind(exNode.id, 'exchange-batch');
      expect(batches.map(b => b.metadata.batch_index)).toEqual([1, 2]);

      const batch1Users = (await store.getChildrenBySeq(batches[0].id)).filter(
        u => u.metadata.role === 'user',
      );
      const batch2Users = (await store.getChildrenBySeq(batches[1].id)).filter(
        u => u.metadata.role === 'user',
      );
      expect(batch1Users.map(u => u.title)).toEqual(['Q1', 'Q2']);
      expect(batch2Users.map(u => u.title)).toEqual(['Q3']);
    });
  });

  describe('showUnsummarized', () => {
    beforeEach(async () => {
      await store.createProject('P0096');
      await sessions.startProjectSession({
        sessionId: 'su',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
        batchSize: 2,
      });
      await sessions.logExchange('su', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'agent', content: 'A2' },
        { role: 'user', content: 'Q3' },
        { role: 'agent', content: 'A3' },
      ]);
    });

    it('returns the first unsummarized batch with user+agent content', async () => {
      const batch = await sessions.showUnsummarized('su');
      expect(batch.batchIndex).toBe(1);
      expect(batch.batchSize).toBe(2);
      expect(batch.exchanges.map(e => [e.seq, e.userContent, e.agentContent])).toEqual([
        [1, 'Q1', 'A1'],
        [2, 'Q2', 'A2'],
      ]);
      expect(batch.hasMore).toBe(true);
      expect(batch.summaryNodeId).toBeTruthy();
    });

    it('skips already-summarized batches (derived from existing Batch nodes)', async () => {
      const summaryNode = (await store.getChildByKind('su', 'session-summary-root'))[0];
      await store.write('Batch 1', {
        parentId: summaryNode.id,
        metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 2 },
      });

      const batch = await sessions.showUnsummarized('su');
      expect(batch.batchIndex).toBe(2);
      expect(batch.exchanges.map(e => e.seq)).toEqual([3]);
      expect(batch.hasMore).toBe(false);
    });
  });

  describe('showUnsummarized re-sweep', () => {
    it('re-sweeps summarized batch when late exchanges appended (partial-batch race)', async () => {
      await store.createProject('P0097');
      await sessions.startProjectSession({
        sessionId: 'su-race',
        projectId: 'P0097',
        agentName: 'a',
        cwd: '/',
        harness: 't',
        batchSize: 2,
      });
      await sessions.logExchange('su-race', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'agent', content: 'A2' },
      ]);
      await sessions.writeBatchSummary('su-race', 1, 'batch one', { seqFrom: 1, seqTo: 2 });

      const exNode = (await store.getChildByKind('su-race', 'exchanges-root'))[0]!;
      const batch1 = (await store.getChildByKind(exNode.id, 'exchange-batch'))
        .find(b => b.metadata.batch_index === 1)!;

      const lateUser = await store.write('Q-late', {
        parentId: batch1.id,
        metadata: { kind: 'exchange', role: 'user', seq: 3, sessionId: 'su-race' },
        tags: ['#exchange'],
      });
      await store.write('A-late', {
        parentId: lateUser.id,
        metadata: { kind: 'exchange', role: 'agent', seq: 3, sessionId: 'su-race' },
        tags: ['#exchange'],
      });

      const batch = await sessions.showUnsummarized('su-race');
      expect(batch.batchIndex).toBe(1);
      expect(batch.exchanges.map(e => e.seq)).toEqual([3]);
      expect(batch.exchanges[0]?.userContent).toBe('Q-late');
      expect(batch.hasMore).toBe(false);
    });
  });

  describe('writeBatchSummary + rollUpSession', () => {
    beforeEach(async () => {
      await store.createProject('P0095');
      await sessions.startProjectSession({
        sessionId: 'sb',
        projectId: 'P0095',
        agentName: 'a',
        cwd: '/',
        harness: 't',
        batchSize: 2,
      });
      await sessions.logExchange('sb', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'agent', content: 'A2' },
      ]);
    });

    it('writes a Batch node under Summary and bumps derived batches_summarized', async () => {
      const batch = await sessions.showUnsummarized('sb');
      const node = await sessions.writeBatchSummary(
        'sb',
        batch.batchIndex,
        'themes: greetings',
        { seqFrom: 1, seqTo: 2 },
        ['#greetings', '#onboarding'],
      );
      expect(node.metadata.kind).toBe('batch-summary');
      expect(node.metadata.batch_index).toBe(1);
      expect(node.metadata.summarized_at).toBeTruthy();
      expect(node.tags).toContain('#session-summary');
      expect(node.tags).toContain('#batch-summary');
      expect(node.tags).toContain('#greetings');

      const { batchesSummarized } = await deriveCounters(store, 'sb');
      expect(batchesSummarized).toBe(1);
    });

    it('aggregateSessionTags promotes tags appearing in 2+ batches to Summary node', async () => {
      await sessions.writeBatchSummary('sb', 1, 'batch one', { seqFrom: 1, seqTo: 1 }, ['#auth', '#ui']);
      await sessions.logExchange('sb', [
        { role: 'user', content: 'Q3' },
        { role: 'agent', content: 'A3' },
        { role: 'user', content: 'Q4' },
        { role: 'agent', content: 'A4' },
      ]);
      await sessions.writeBatchSummary('sb', 2, 'batch two', { seqFrom: 3, seqTo: 4 }, ['#auth', '#db']);

      const summaryNode = (await store.getChildByKind('sb', 'session-summary-root'))[0]!;
      expect(summaryNode.tags).toContain('#auth');
      expect(summaryNode.tags).not.toContain('#ui');
      expect(summaryNode.tags).not.toContain('#db');
    });

    it('showUntagged lists batch nodes with only structural tags', async () => {
      await sessions.writeBatchSummary('sb', 1, 'no tags here', { seqFrom: 1, seqTo: 2 });
      await sessions.logExchange('sb', [
        { role: 'user', content: 'Q3' },
        { role: 'agent', content: 'A3' },
        { role: 'user', content: 'Q4' },
        { role: 'agent', content: 'A4' },
      ]);
      await sessions.writeBatchSummary('sb', 2, 'tagged batch', { seqFrom: 3, seqTo: 4 }, ['#feature-x']);

      const untagged = await sessions.showUntagged();
      expect(untagged.some(u => u.sessionId === 'sb' && u.batchIndex === 1)).toBe(true);
      expect(untagged.some(u => u.sessionId === 'sb' && u.batchIndex === 2)).toBe(false);
    });

    it('is idempotent: re-writing the same batch_index does not duplicate', async () => {
      await sessions.writeBatchSummary('sb', 1, 'first', { seqFrom: 1, seqTo: 2 });
      await sessions.writeBatchSummary('sb', 1, 'again', { seqFrom: 1, seqTo: 2 });
      const summaryNode = (await store.getChildByKind('sb', 'session-summary-root'))[0];
      const batches = await store.getChildByKind(summaryNode.id, 'batch-summary');
      expect(batches).toHaveLength(1);
    });

    it('parallel writes for same batch_index yield exactly one node', async () => {
      const summaryNode = (await store.getChildByKind('sb', 'session-summary-root'))[0]!;
      const dbPath = path.join(os.tmpdir(), `tim-batch-race-${Date.now()}.db`);
      const fileStore = new TimStore(dbPath);
      try {
        const fileSessions = new SessionManager(fileStore);
        await fileStore.createProject('P0095');
        await fileSessions.startProjectSession({
          sessionId: 'sb-file',
          projectId: 'P0095',
          agentName: 'a',
          cwd: '/',
          harness: 't',
          batchSize: 2,
        });
        await fileSessions.logExchange('sb-file', [
          { role: 'user', content: 'Q1' },
          { role: 'agent', content: 'A1' },
        ]);
        const sn = (await fileStore.getChildByKind('sb-file', 'session-summary-root'))[0]!;

        const storeB = new TimStore(dbPath);
        const sessionsB = new SessionManager(storeB);
        await Promise.all([
          fileSessions.writeBatchSummary('sb-file', 5, 'from A', { seqFrom: 1, seqTo: 1 }),
          sessionsB.writeBatchSummary('sb-file', 5, 'from B', { seqFrom: 1, seqTo: 1 }),
        ]);

        const batches = await fileStore.getChildByKind(sn.id, 'batch-summary');
        const batch5 = batches.filter(b => b.metadata.batch_index === 5);
        expect(batch5).toHaveLength(1);
        storeB.close();
      } finally {
        fileStore.close();
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });

    it('rollUpSession folds all batches into the Summary node body + metadata (multi-line safe)', async () => {
      await sessions.writeBatchSummary('sb', 1, 'batch one summary', { seqFrom: 1, seqTo: 2 });
      const summary = await sessions.rollUpSession('sb', async batches =>
        `Themes:\n${batches.map(b => b.content).join('\n')}`,
      );

      expect(summary.content.startsWith('Themes:')).toBe(true);
      expect(summary.content).toContain('batch one summary');
      expect(summary.metadata.summary).toContain('Themes:');
      expect(summary.metadata.exchanges).toBe(2);
      expect(summary.tags).toContain('#session-summary');
    });
  });

  describe('onBatchFull live trigger', () => {
    it('fires when logExchange rolls to a new batch', async () => {
      const onBatchFull = vi.fn();
      sessions.setOnBatchFull(onBatchFull);
      await store.createProject('P0093');
      await sessions.startProjectSession({
        sessionId: 'live',
        projectId: 'P0093',
        agentName: 'a',
        cwd: '/tmp/live',
        harness: 't',
        batchSize: 2,
      });
      await sessions.logExchange('live', [
        { role: 'user', content: 'Q1' },
        { role: 'agent', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'agent', content: 'A2' },
        { role: 'user', content: 'Q3' },
      ]);
      expect(onBatchFull).toHaveBeenCalledOnce();
      expect(onBatchFull.mock.calls[0][0]).toMatchObject({
        sessionId: 'live',
        batchIndex: 1,
      });
    });
  });

  describe('getSessionExchanges tree-awareness', () => {
    it('reads exchanges from the Exchanges subtree for project sessions', async () => {
      await store.createProject('P0094');
      await sessions.startProjectSession({
        sessionId: 'sc',
        projectId: 'P0094',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      await sessions.logExchange('sc', [
        { role: 'user', content: 'U1' },
        { role: 'agent', content: 'Ag1' },
      ]);

      const ex = await sessions.getSessionExchanges('sc');
      expect(ex.map(e => e.metadata.role)).toEqual(['user', 'agent']);
    });
  });

  describe('recentActiveProjects', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('orders projects by most recent session, excludes Inbox, joins titles', async () => {
      vi.useFakeTimers();
      await store.createProject('P0071', { content: 'Alpha — first project' });
      await store.createProject('P0072', { content: 'Beta — second project' });
      await ensureInboxProject(store);

      const startAt = async (iso: string, sessionId: string, projectId: string) => {
        vi.setSystemTime(new Date(iso));
        await sessions.startProjectSession({
          sessionId,
          projectId,
          agentName: 'a',
          cwd: '/',
          harness: 't',
        });
      };
      await startAt('2026-07-01T10:00:00Z', 's-a1', 'P0071');
      await startAt('2026-07-02T10:00:00Z', 's-b1', 'P0072');
      await startAt('2026-07-03T10:00:00Z', 's-a2', 'P0071');
      await startAt('2026-07-04T10:00:00Z', 's-inbox', 'P0000');

      const recents = await store.recentActiveProjects(5);
      expect(recents.map(r => r.label)).toEqual(['P0071', 'P0072']);
      expect(recents[0].lastActive.slice(0, 10)).toBe('2026-07-03');
      expect(recents[0].title).toContain('Alpha');
    });

    it('respects the limit and returns empty without sessions', async () => {
      expect(await store.recentActiveProjects(5)).toEqual([]);

      vi.useFakeTimers();
      for (let i = 1; i <= 3; i++) {
        await store.createProject(`P008${i}`);
        vi.setSystemTime(new Date(`2026-07-0${i}T10:00:00Z`));
        await sessions.startProjectSession({
          sessionId: `s-${i}`,
          projectId: `P008${i}`,
          agentName: 'a',
          cwd: '/',
          harness: 't',
        });
      }
      const recents = await store.recentActiveProjects(2);
      expect(recents.map(r => r.label)).toEqual(['P0083', 'P0082']);
    });

    it('drops projects whose project entry was deleted (soft or hard)', async () => {
      vi.useFakeTimers();
      await store.createProject('P0091', { content: 'Kept' });
      const soft = await store.createProject('P0092', { content: 'Soft-deleted' });
      const hard = await store.createProject('P0093', { content: 'Hard-deleted' });
      for (const [i, label] of (['P0091', 'P0092', 'P0093'] as const).entries()) {
        vi.setSystemTime(new Date(`2026-07-0${i + 1}T10:00:00Z`));
        await sessions.startProjectSession({
          sessionId: `s-del-${label}`,
          projectId: label,
          agentName: 'a',
          cwd: '/',
          harness: 't',
        });
      }
      await store.delete(soft.id);
      await store.delete(hard.id, true);

      const recents = await store.recentActiveProjects(5);
      expect(recents.map(r => r.label)).toEqual(['P0091']);
    });
  });
});
