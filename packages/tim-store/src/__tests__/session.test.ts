import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InProcessEventBus } from 'tim-core';
import { TimStore, SessionManager } from '../index.js';

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

    it('runs decay only after summary is durable', async () => {
      const old = await store.write('old entry', {
        metadata: { kind: 'note' },
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

      const summary = await sessions.checkpoint('sess-decay');

      const oldRead = await store.read(old.id, { showIrrelevant: true });
      expect(oldRead?.irrelevant).toBe(true);

      const sessionRead = await store.read('sess-decay');
      const summaryRead = await store.read(summary.id);
      expect(sessionRead).not.toBeNull();
      expect(summaryRead).not.toBeNull();
    });

    it('uses default summarizer stub truncated to 2000 chars', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-stub',
        agentName: 'agent',
        cwd: '/',
        harness: 'test',
      });
      await sessions.sessionLog('sess-stub', [
        { role: 'user', content: 'x'.repeat(1500) },
        { role: 'agent', content: 'y'.repeat(1500) },
      ]);

      const summary = await sessions.checkpoint('sess-stub', { runDecay: false });
      expect(summary.content.length).toBeLessThanOrEqual(2001);
      expect(summary.content.endsWith('…')).toBe(true);
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

      const old = await eventStore.write('stale data');
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

      const summary = await eventSessions.checkpoint('lifecycle');

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
});
