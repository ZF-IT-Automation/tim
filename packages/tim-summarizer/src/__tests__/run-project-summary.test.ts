import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, SessionManager } from 'tim-store';
import * as generateSummary from '../generate-summary.js';
import { mergeProjectSummary, runProjectSummary } from '../summarize.js';

describe('runProjectSummary session sourcing', () => {
  let store: TimStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-run-project-summary-'));
    dbPath = path.join(tmpDir, 'test.db');
    process.env.TIM_DB_PATH = dbPath;
    store = new TimStore(dbPath);
    await store.createProject('P0099', { content: 'Huge project' });
    const project = await store.requireProject('P0099');

    for (let i = 0; i < 250; i++) {
      await store.write(`Noise ${i}`, {
        parentId: project.id,
        metadata: { kind: 'note' },
      });
    }

    const sessions = new SessionManager(store);
    for (let s = 1; s <= 4; s++) {
      const id = `sess-${s}`;
      await sessions.startProjectSession({
        sessionId: id,
        projectId: 'P0099',
        agentName: 'test',
        cwd: '/tmp',
        harness: 'test',
      });
      for (let e = 1; e <= 3; e++) {
        await sessions.logExchange(id, [
          { role: 'user', content: `q${s}-${e}` },
          { role: 'agent', content: `a${s}-${e}` },
        ]);
      }
      await sessions.updateSessionSummary(id, `summary for session ${s}`);
    }
    store.close();

    vi.spyOn(generateSummary, 'generateProjectSummary').mockResolvedValue('- rolled up project news');
  });

  afterEach(() => {
    delete process.env.TIM_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sources newest substantive sessions directly, not via loadProject budget', async () => {
    const wrote = await runProjectSummary('P0099');
    expect(wrote).toBe(true);

    const verify = new TimStore(dbPath);
    const project = await verify.requireProject('P0099');
    verify.close();

    const merged = mergeProjectSummary('', project.content);
    expect(merged).toMatch(/_Covers 4 sessions, .+ – .+_/);
    expect(merged).toContain('- rolled up project news');
    expect(generateSummary.generateProjectSummary).toHaveBeenCalled();
    const arg = vi.mocked(generateSummary.generateProjectSummary).mock.calls[0][0];
    expect(arg.length).toBeGreaterThanOrEqual(4);
  });
});
