import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
} from 'tim-store';
import { runBackfillSubstance } from '../summarize.js';
import * as generateSummary from '../generate-summary.js';

describe('runBackfillSubstance', () => {
  let dbPath: string;
  let store: TimStore;
  let sessions: SessionManager;
  let savedDbPath: string | undefined;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `tim-backfill-${Date.now()}.db`);
    savedDbPath = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = dbPath;
    store = new TimStore(dbPath);
    sessions = new SessionManager(store);
    await store.createProject('P7700', { content: 'backfill tests' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (savedDbPath === undefined) delete process.env.TIM_DB_PATH;
    else process.env.TIM_DB_PATH = savedDbPath;
  });

  async function seedIdleSession(id: string, exchanges: number): Promise<string> {
    await sessions.startProjectSession({
      sessionId: id,
      projectId: 'P7700',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
    });
    for (let i = 1; i <= exchanges; i++) {
      await sessions.logExchange(id, [
        { role: 'user', content: `q${i}` },
        { role: 'agent', content: `a${i}` },
      ]);
    }
    const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
    expect(summaryNode).toBeTruthy();
    return summaryNode!.id;
  }

  function backdateSessionTree(sessionId: string): void {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    store.getDb().prepare(`
      WITH RECURSIVE sub AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e
        INNER JOIN sub ON e.parent_id = sub.id
        WHERE e.tombstoned_at IS NULL
      )
      UPDATE entries SET created_at = ? WHERE id IN (SELECT id FROM sub)
    `).run(sessionId, old);
  }

  it('skips live sessions with recent activity', async () => {
    await sessions.startProjectSession({
      sessionId: 'live-sess',
      projectId: 'P7700',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
    });
    await sessions.logExchange('live-sess', [
      { role: 'user', content: 'still going' },
      { role: 'agent', content: 'yes' },
    ]);
    store.close();

    const counts = await runBackfillSubstance({ project: 'P7700', dryRun: true });
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
    expect(counts.none).toBe(0);
    expect(counts.failed).toBe(0);
  });

  it('counts LLM failure without writing a substance verdict', async () => {
    const summaryId = await seedIdleSession('idle-llm-fail', 3);
    await sessions.writeBatchSummary(
      'idle-llm-fail',
      1,
      'did some work on the parser',
      { seqFrom: 1, seqTo: 3 },
    );
    backdateSessionTree('idle-llm-fail');
    store.close();

    vi.spyOn(generateSummary, 'generateSubstanceVerdict').mockResolvedValue(undefined);

    const counts = await runBackfillSubstance({ project: 'P7700' });
    expect(counts.failed).toBe(1);
    expect(counts.real).toBe(0);
    expect(counts.low).toBe(0);

    const verify = new TimStore(dbPath);
    const summaryNode = await verify.read(summaryId);
    expect(summaryNode?.metadata.substance).toBeUndefined();
    verify.close();
  });

  it('retries LLM failure on a later run', async () => {
    await seedIdleSession('idle-retry', 3);
    await sessions.writeBatchSummary(
      'idle-retry',
      1,
      'real project work here',
      { seqFrom: 1, seqTo: 3 },
    );
    backdateSessionTree('idle-retry');
    store.close();

    vi.spyOn(generateSummary, 'generateSubstanceVerdict').mockResolvedValueOnce(undefined);

    const first = await runBackfillSubstance({ project: 'P7700' });
    expect(first.failed).toBe(1);

    vi.spyOn(generateSummary, 'generateSubstanceVerdict').mockResolvedValueOnce('real');

    const second = await runBackfillSubstance({ project: 'P7700' });
    expect(second.failed).toBe(0);
    expect(second.real).toBe(1);
  });
});
