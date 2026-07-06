import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimStore, SessionManager, ensureInboxProject } from 'tim-store';
import { buildInboxFallbackGuidance } from '../session-guidance.js';

describe('buildInboxFallbackGuidance', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(() => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('returns null when no project sessions exist', async () => {
    expect(await buildInboxFallbackGuidance(store)).toBeNull();
  });

  it('lists recent projects with bind directive, Inbox excluded', async () => {
    vi.useFakeTimers();
    await store.createProject('P0071', { content: 'Alpha — test project' });
    await ensureInboxProject(store);

    vi.setSystemTime(new Date('2026-07-01T10:00:00Z'));
    await sessions.startProjectSession({
      sessionId: 's1',
      projectId: 'P0071',
      agentName: 'a',
      cwd: '/',
      harness: 't',
    });
    vi.setSystemTime(new Date('2026-07-02T10:00:00Z'));
    await sessions.startProjectSession({
      sessionId: 's2',
      projectId: 'P0000',
      agentName: 'a',
      cwd: '/',
      harness: 't',
    });

    const guidance = await buildInboxFallbackGuidance(store);
    expect(guidance).toContain('bound to the Inbox (P0000)');
    expect(guidance).toContain('P0071 — Alpha');
    expect(guidance).toContain('last active 2026-07-01');
    expect(guidance).toContain('tim_load_project(label="P00XX")');
    expect(guidance).not.toContain('P0000 —');
  });

  it('returns null when the store query fails', async () => {
    const broken = {
      recentActiveProjects: async () => {
        throw new Error('db locked');
      },
    } as unknown as TimStore;
    expect(await buildInboxFallbackGuidance(broken)).toBeNull();
  });
});
