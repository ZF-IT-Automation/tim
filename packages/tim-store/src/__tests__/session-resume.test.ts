import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from '../index.js';

describe('resolveSessionAlias', () => {
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
