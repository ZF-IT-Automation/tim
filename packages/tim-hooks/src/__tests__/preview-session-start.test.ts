import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TimStore, SessionManager } from 'tim-store';
import { previewSessionStart, runSessionStart } from '../checkpoint.js';

const TEST_ROOT = path.join(os.tmpdir(), 'tim-test-runs');

/**
 * previewSessionStart exists so a briefing can be inspected without being
 * caused. runSessionStart, the thing it mirrors, creates a session node and may
 * write a marker before it assembles any text — so the tests that matter are
 * the ones proving the preview does neither. The pair is asserted together:
 * a preview that stopped reproducing runSessionStart would be worthless even
 * while staying perfectly side-effect-free.
 */
describe('previewSessionStart', () => {
  let dir: string;
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'preview-start-'));
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0055');
    await sessions.startProjectSession({
      sessionId: 'prev-1',
      projectId: 'P0055',
      agentName: 'a',
      cwd: dir,
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('prev-1', [
      { role: 'user', content: 'q' },
      { role: 'agent', content: 'a' },
    ]);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sessionCount = async (): Promise<number> =>
    (await sessions.listResumableSessions('P0055', 50)).length;

  it('creates no session and writes no marker', async () => {
    const before = await sessionCount();
    await previewSessionStart(store, { projectId: 'P0055', maxTokens: 400, cwd: dir });
    expect(await sessionCount()).toBe(before);
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('names the session it computed the delta against', async () => {
    const preview = await previewSessionStart(store, {
      projectId: 'P0055',
      maxTokens: 400,
      cwd: dir,
    });
    // Defaulted, not guessed: the newest session of the project.
    expect(preview.sessionId).toBe('prev-1');
    expect(preview.projectLabel).toBe('P0055');
  });

  it('emits the same directive a start hook would', async () => {
    const preview = await previewSessionStart(store, {
      projectId: 'P0055',
      maxTokens: 400,
      cwd: dir,
    });
    expect(preview.directive).toContain('TIM project marker detected');
    expect(preview.directive).toContain('tim_load_project(label="P0055")');

    // The session flavour is the other directive a hook can emit.
    const fromSession = await previewSessionStart(store, {
      projectId: 'P0055',
      maxTokens: 400,
      cwd: dir,
      origin: 'session',
    });
    expect(fromSession.directive).toContain('TIM session bound to project');
  });

  // The automatic session start stopped asking for past work (topic recall,
  // criterion 8), which leaves this the only caller that does. Without this
  // test the render blocks in briefingBlock look dead and get deleted — and
  // /tim-continue, which is exactly this call, would quietly render nothing.
  it('still renders the previous session and its uncovered turns', async () => {
    await sessions.updateSessionSummary('prev-1', 'rolled up: wired the reader');
    await sessions.logExchange('prev-1', [
      { role: 'user', content: 'uncovered question' },
      { role: 'agent', content: 'uncovered answer' },
    ]);

    const preview = await previewSessionStart(store, {
      projectId: 'P0055',
      maxTokens: 1000,
      cwd: dir,
    });

    expect(preview.directive).toContain('── Previous session');
    expect(preview.directive).toContain('rolled up: wired the reader');
    // Both render blocks, not just the summary one: the raw tail is what a
    // session that died mid-work leaves behind.
    expect(preview.directive).toContain('── Since the last summary ──');
    expect(preview.directive).toContain('uncovered question');
  });

  it('refuses an unknown project instead of briefing on nothing', async () => {
    await expect(
      previewSessionStart(store, { projectId: 'P9999', maxTokens: 400, cwd: dir }),
    ).rejects.toThrow(/No project/);
  });

  it('still mirrors runSessionStart, which does create a session', async () => {
    // listResumableSessions only returns sessions that already have exchanges,
    // so the contrast is drawn on the session node itself.
    await previewSessionStart(store, { projectId: 'P0055', maxTokens: 400, cwd: dir });
    expect(await store.read('preview-only-1')).toBeNull();

    const result = await runSessionStart(store, {
      sessionId: 'preview-only-1',
      agentName: 'a',
      cwd: dir,
      harness: 't',
      projectId: 'P0055',
    });
    // The contrast is the point: the write path writes, the preview does not.
    expect(await store.read(result.session.id)).not.toBeNull();
  });
});
