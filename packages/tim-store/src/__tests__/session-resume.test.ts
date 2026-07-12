import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from '../index.js';

describe('session resume', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0099', { content: 'Test project' });
  });

  afterEach(() => {
    store.close();
  });

  async function startSession(id: string) {
    return sessions.startProjectSession({
      sessionId: id,
      projectId: 'P0099',
      agentName: 'test',
      cwd: '/tmp/x',
      harness: 'test',
    });
  }

  describe('resolveSessionAlias', () => {
    it('is identity for unknown ids', () => {
      expect(store.resolveSessionAlias('nope')).toBe('nope');
    });

    it('is identity for canonical session ids', async () => {
      await startSession('sess-A');
      expect(store.resolveSessionAlias('sess-A')).toBe('sess-A');
    });

    it('resolves an aliased harness id to the canonical session', async () => {
      const s = await startSession('sess-A');
      await store.update(s.id, {
        metadata: { ...s.metadata, resumed_by: ['harness-B'] },
      });
      expect(store.resolveSessionAlias('harness-B')).toBe('sess-A');
    });

    it('resolves any of multiple aliases', async () => {
      const s = await startSession('sess-A');
      await store.update(s.id, {
        metadata: { ...s.metadata, resumed_by: ['harness-B', 'harness-C'] },
      });
      expect(store.resolveSessionAlias('harness-C')).toBe('sess-A');
    });
  });

  describe('resumeSession', () => {
    async function seedSession(id: string, exchangeCount: number) {
      await startSession(id);
      for (let i = 1; i <= exchangeCount; i++) {
        await sessions.logExchange(id, [
          { role: 'user', content: `user msg ${i}` },
          { role: 'agent', content: `agent msg ${i}` },
        ]);
      }
    }

    it('returns summary, batch summaries in order, and last N raw exchanges ascending', async () => {
      await seedSession('sess-R', 12);
      await sessions.writeBatchSummary('sess-R', 1, 'summary of batch 1', { seqFrom: 1, seqTo: 5 });
      await sessions.writeBatchSummary('sess-R', 2, 'summary of batch 2', { seqFrom: 6, seqTo: 10 });
      await sessions.updateSessionSummary('sess-R', 'overall session summary');

      const p = await sessions.resumeSession('sess-R', { newHarnessId: 'harness-2', rawCount: 10 });

      expect(p.sessionId).toBe('sess-R');
      expect(p.sessionSummary).toBe('overall session summary');
      expect(p.batchSummaries.map(b => b.batchIndex)).toEqual([1, 2]);
      expect(p.batchSummaries[0]!.text).toBe('summary of batch 1');
      expect(p.recentExchanges).toHaveLength(10);
      expect(p.recentExchanges[0]!.seq).toBe(3);
      expect(p.recentExchanges[9]!.seq).toBe(12);
      expect(p.recentExchanges[9]!.userContent).toBe('user msg 12');
      expect(p.recentExchanges[9]!.agentContent).toBe('agent msg 12');
    });

    it('returns all exchanges when fewer than rawCount', async () => {
      await seedSession('sess-S', 3);
      const p = await sessions.resumeSession('sess-S', { newHarnessId: 'h-x' });
      expect(p.recentExchanges).toHaveLength(3);
    });

    it('records alias idempotently and accumulates tool_history', async () => {
      await seedSession('sess-T', 1);
      await sessions.resumeSession('sess-T', { newHarnessId: 'h-1', tool: 'cursor' });
      await sessions.resumeSession('sess-T', { newHarnessId: 'h-1', tool: 'cursor' });
      await sessions.resumeSession('sess-T', { newHarnessId: 'h-2', tool: 'codex' });

      const s = (await store.read('sess-T'))!;
      expect(s.metadata.resumed_by).toEqual(['h-1', 'h-2']);
      expect(s.metadata.tool).toBe('codex');
      expect(s.metadata.tool_history).toEqual(['cursor', 'codex']);
      expect(typeof s.metadata.resumed_at).toBe('string');
    });

    it('warns when no batch summaries exist', async () => {
      await seedSession('sess-U', 2);
      const p = await sessions.resumeSession('sess-U', { newHarnessId: 'h-u' });
      expect(p.warnings.some(w => w.includes('batch summaries'))).toBe(true);
    });

    it('warns when no harness id is provided and records no alias', async () => {
      await seedSession('sess-V', 1);
      const p = await sessions.resumeSession('sess-V', {});
      expect(p.warnings.some(w => w.includes('harness'))).toBe(true);
      const s = (await store.read('sess-V'))!;
      expect(s.metadata.resumed_by).toBeUndefined();
    });

    it('rejects when newHarnessId is a session with exchanges', async () => {
      await seedSession('sess-W', 1);
      await seedSession('sess-X', 2);
      await expect(
        sessions.resumeSession('sess-W', { newHarnessId: 'sess-X' }),
      ).rejects.toThrow(/already has/);
    });

    it('allows self-resume (old id == new harness id) without alias', async () => {
      await seedSession('sess-Y', 2);
      const p = await sessions.resumeSession('sess-Y', { newHarnessId: 'sess-Y' });
      expect(p.sessionId).toBe('sess-Y');
      const s = (await store.read('sess-Y'))!;
      expect(s.metadata.resumed_by).toBeUndefined();
    });

    it('tolerates an empty auto-created session node as newHarnessId', async () => {
      await seedSession('sess-Z', 1);
      await startSession('sess-EMPTY'); // session node, zero exchanges
      const p = await sessions.resumeSession('sess-Z', { newHarnessId: 'sess-EMPTY' });
      expect(p.sessionId).toBe('sess-Z');
      const s = (await store.read('sess-Z'))!;
      expect(s.metadata.resumed_by).toEqual(['sess-EMPTY']);
    });

    it('rejects legacy flat sessions (no exchanges-root)', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-flat', agentName: 'a', cwd: '/tmp', harness: 'h',
      });
      await expect(sessions.resumeSession('sess-flat', {})).rejects.toThrow(/legacy/);
    });

    it('rejects unknown session ids', async () => {
      await expect(sessions.resumeSession('nope', {})).rejects.toThrow(/not found/i);
    });
  });

  describe('listResumableSessions', () => {
    it('lists sessions of the project sorted by last activity, newest first', async () => {
      const a = await startSession('sess-old');
      await sessions.logExchange('sess-old', [
        { role: 'user', content: 'old work' },
        { role: 'agent', content: 'ok' },
      ]);
      await startSession('sess-new');
      await sessions.logExchange('sess-new', [
        { role: 'user', content: 'new work' },
        { role: 'agent', content: 'ok' },
      ]);
      // touch the OLD session again — it becomes most recently active
      await sessions.logExchange('sess-old', [
        { role: 'user', content: 'back to old' },
        { role: 'agent', content: 'ok' },
      ]);
      await sessions.updateSessionSummary('sess-old', 'first line of old summary\nmore text');

      const list = await sessions.listResumableSessions('P0099');
      expect(list.map(s => s.sessionId)).toEqual(['sess-old', 'sess-new']);
      expect(list[0]!.exchangeCount).toBe(2);
      expect(list[0]!.summaryFirstLine).toBe('first line of old summary');
      expect(a.id).toBe('sess-old');
    });

    it('respects the limit', async () => {
      for (let i = 0; i < 4; i++) await startSession(`sess-l${i}`);
      const list = await sessions.listResumableSessions('P0099', 2);
      expect(list).toHaveLength(2);
    });

    it('returns empty array for a project without sessions', async () => {
      await store.createProject('P0098', { content: 'empty' });
      expect(await sessions.listResumableSessions('P0098')).toEqual([]);
    });
  });
});
