import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, SessionManager } from 'tim-store';
import * as mcpClient from '../mcp-client.js';
import * as generate from '../generate-summary.js';
import { runSummarizerLoop } from '../summarize.js';

const PROJECT = 'P0300';
const SESSION = 'sess-condense';

const emptyBatch = {
  sessionId: SESSION,
  summaryNodeId: 's',
  exchangesNodeId: 'e',
  batchIndex: 2,
  batchSize: 2,
  exchanges: [],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: {},
};

/** Args the loop passed to tim_rollup_session_summary. */
function rollupArgs(): Record<string, unknown> {
  const call = vi
    .mocked(mcpClient.callTimTool)
    .mock.calls.find(([, tool]) => tool === 'tim_rollup_session_summary');
  return (call?.[2] ?? {}) as Record<string, unknown>;
}

describe('session rollup condenses batch summaries', () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-rollup-'));
    dbPath = path.join(root, 'tim.db');
    vi.stubEnv('TIM_DB_PATH', dbPath);

    // Seed two already-written batch summaries, then close so the loop's own
    // connection sees a committed tree.
    const store = new TimStore(dbPath);
    const sessions = new SessionManager(store);
    await store.createProject(PROJECT);
    await sessions.startProjectSession({
      sessionId: SESSION,
      projectId: PROJECT,
      agentName: 'agent',
      cwd: root,
      harness: 'test',
      batchSize: 2,
    });
    await sessions.writeBatchSummary(SESSION, 1, 'batch one themes', { seqFrom: 1, seqTo: 2 });
    await sessions.writeBatchSummary(SESSION, 2, 'batch two themes', { seqFrom: 3, seqTo: 4 });
    store.close();

    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool').mockResolvedValue(emptyBatch as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes the condensed text as the summary argument', async () => {
    const spy = vi
      .spyOn(generate, 'generateSessionRollup')
      .mockResolvedValue('handoff: state, open threads, next step');

    await runSummarizerLoop(SESSION);

    // All batch summaries of the session, in batch order — not just this run's.
    expect(spy).toHaveBeenCalledWith(
      ['batch one themes', 'batch two themes'],
      expect.any(Function),
    );
    expect(rollupArgs()).toEqual({
      sessionId: SESSION,
      summary: 'handoff: state, open threads, next step',
    });
  });

  it('omits the summary argument when condensation fails, so the server folds', async () => {
    vi.spyOn(generate, 'generateSessionRollup').mockResolvedValue(null);

    await runSummarizerLoop(SESSION);

    expect(rollupArgs()).toEqual({ sessionId: SESSION });
  });
});

describe('generateSessionRollup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for an empty batch list without spawning a CLI', async () => {
    const tryCli = vi.spyOn(generate, 'tryCli');
    await expect(generate.generateSessionRollup([])).resolves.toBeNull();
    expect(tryCli).not.toHaveBeenCalled();
  });

  it('returns null when every CLI in the chain fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = await import('tim-core');
    vi.spyOn(config, 'loadConfig').mockReturnValue({
      dbPath: ':memory:',
      deviceId: 'test',
      summarizer: { chain: [{ cli: 'definitely-not-a-real-cli-xyz', model: 'm' }], timeout_sec: 5 },
    } as ReturnType<typeof config.loadConfig>);

    await expect(generate.generateSessionRollup(['a', 'b'])).resolves.toBeNull();
  });
});
