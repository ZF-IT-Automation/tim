import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { TimStore, SessionManager, resolveCurrentSession } from '../index.js';

describe('resolveCurrentSession', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(() => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
  });

  it('returns the latest session for the matching cwd', async () => {
    await store.createProject('P0099');
    const cwdA = path.resolve('/tmp/project-a');

    await sessions.startProjectSession({
      sessionId: 'sess-a-old',
      projectId: 'P0099',
      agentName: 'test',
      cwd: cwdA,
      harness: 'vitest',
    });
    await new Promise(r => setTimeout(r, 5));
    await sessions.startProjectSession({
      sessionId: 'sess-a-new',
      projectId: 'P0099',
      agentName: 'test',
      cwd: cwdA,
      harness: 'vitest',
    });

    const resolved = await resolveCurrentSession(store, 'P0099', cwdA);
    expect(resolved?.id).toBe('sess-a-new');
    expect(resolved?.metadata.cwd).toBe(cwdA);
  });

  it('returns null for an unknown cwd', async () => {
    await store.createProject('P0099');
    await sessions.startProjectSession({
      sessionId: 'sess-only',
      projectId: 'P0099',
      agentName: 'test',
      cwd: '/tmp/known',
      harness: 'vitest',
    });

    expect(await resolveCurrentSession(store, 'P0099', '/tmp/unknown')).toBeNull();
  });

  it('returns the newest session when two sessions share a cwd', async () => {
    await store.createProject('P0098');
    const shared = path.resolve('/tmp/shared');

    await sessions.startProjectSession({
      sessionId: 'shared-1',
      projectId: 'P0098',
      agentName: 'test',
      cwd: shared,
      harness: 'vitest',
    });
    await new Promise(r => setTimeout(r, 5));
    await sessions.startProjectSession({
      sessionId: 'shared-2',
      projectId: 'P0098',
      agentName: 'test',
      cwd: shared,
      harness: 'vitest',
    });

    const resolved = await resolveCurrentSession(store, 'P0098', shared);
    expect(resolved?.id).toBe('shared-2');
  });

  it('filters by cwd when sessions exist on different cwds', async () => {
    await store.createProject('P0097');
    const cwdA = path.resolve('/tmp/a');
    const cwdB = path.resolve('/tmp/b');

    await sessions.startProjectSession({
      sessionId: 'sess-b',
      projectId: 'P0097',
      agentName: 'test',
      cwd: cwdB,
      harness: 'vitest',
    });
    await new Promise(r => setTimeout(r, 5));
    await sessions.startProjectSession({
      sessionId: 'sess-a',
      projectId: 'P0097',
      agentName: 'test',
      cwd: cwdA,
      harness: 'vitest',
    });

    expect((await resolveCurrentSession(store, 'P0097', cwdA))?.id).toBe('sess-a');
    expect((await resolveCurrentSession(store, 'P0097', cwdB))?.id).toBe('sess-b');
  });

  it('returns the newest session across all cwds when cwd is undefined', async () => {
    await store.createProject('P0096');
    const cwdA = path.resolve('/tmp/fallback-a');
    const cwdB = path.resolve('/tmp/fallback-b');

    await sessions.startProjectSession({
      sessionId: 'fallback-old',
      projectId: 'P0096',
      agentName: 'test',
      cwd: cwdA,
      harness: 'vitest',
    });
    await new Promise(r => setTimeout(r, 5));
    await sessions.startProjectSession({
      sessionId: 'fallback-new',
      projectId: 'P0096',
      agentName: 'test',
      cwd: cwdB,
      harness: 'vitest',
    });

    const resolved = await resolveCurrentSession(store, 'P0096');
    expect(resolved?.id).toBe('fallback-new');
  });

  it('returns null when the project has no sessions', async () => {
    await store.createProject('P0095');
    expect(await resolveCurrentSession(store, 'P0095', '/tmp/none')).toBeNull();
    expect(await resolveCurrentSession(store, 'P0095')).toBeNull();
  });
});
