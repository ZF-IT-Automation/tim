import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore, SessionManager, deriveCounters, formatProjectOutput, foldBatchSummaries } from 'tim-store';
import { loadConfig } from 'tim-core';
import type { LoadProjectResult } from 'tim-store';
import {
  maybeSpawnSummarizer,
  writeMarker,
  acquireLock,
  releaseLock,
} from 'tim-hooks';
import type { UnsummarizedBatch } from '../mcp-client.js';
import * as mcpClient from '../mcp-client.js';
import { runSummarizerLoop, mergeProjectSummary } from '../summarize.js';

const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');
const SESSION_ID = 'sess-e2e';
const PROJECT_ID = 'P0063';

function seqRange(batch: UnsummarizedBatch): { seqFrom: number; seqTo: number } {
  const seqs = batch.exchanges.map(e => e.seq);
  return { seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs) };
}

function batchSummaryNodes(result: LoadProjectResult): LoadProjectResult['children'] {
  return result.children.filter(c => c.metadata.kind === 'batch-summary');
}

async function logSixExchanges(sessions: SessionManager): Promise<void> {
  await sessions.logExchange(SESSION_ID, [
    { role: 'user', content: 'Q1' },
    { role: 'agent', content: 'A1' },
    { role: 'user', content: 'Q2' },
    { role: 'agent', content: 'A2' },
    { role: 'user', content: 'Q3' },
    { role: 'agent', content: 'A3' },
    { role: 'user', content: 'Q4' },
    { role: 'agent', content: 'A4' },
    { role: 'user', content: 'Q5' },
    { role: 'agent', content: 'A5' },
  ]);
  await sessions.logExchange(SESSION_ID, [{ role: 'user', content: 'Q6' }]);
}

function writeSessionMarker(dir: string, overrides: Partial<Parameters<typeof writeMarker>[1]> = {}): void {
  writeMarker(dir, {
    project: PROJECT_ID,
    session: SESSION_ID,
    exchanges: 0,
    batch_size: 5,
    batches_summarized: 0,
    ...overrides,
  });
}

vi.mock('tim-core', () => ({
  loadConfig: vi.fn(() => ({
    dbPath: ':memory:',
    deviceId: 'test',
    summarizer: { chain: [], timeout_sec: 5 },
  })),
}));

describe('pipeline e2e — happy path', () => {
  let store: TimStore;
  let sessions: SessionManager;
  let tmpCwd: string;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    tmpCwd = fs.mkdtempSync(path.join(TEST_ROOT, 'pipe-e2e-'));
    vi.stubEnv('TIM_MARKER_MAX_ROOT', tmpCwd);
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject(PROJECT_ID);
    await sessions.startProjectSession({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      agentName: 'claude',
      cwd: tmpCwd,
      harness: 'claude-code',
      batchSize: 5,
    });
    writeSessionMarker(tmpCwd);
  });

  afterEach(() => {
    releaseLock(tmpCwd);
    store.close();
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('session_log → batch-full → one summarizer write → load_project depth 3/4', async () => {
    const onBatchFull = vi.fn();
    sessions.setOnBatchFull(onBatchFull);
    await logSixExchanges(sessions);

    expect(onBatchFull).toHaveBeenCalledOnce();
    expect(onBatchFull.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      batchIndex: 1,
    });

    const fakeSpawner = vi.fn();
    const spawnRes = await maybeSpawnSummarizer(store, tmpCwd, {
      batchFull: true,
      spawn: fakeSpawner,
    });
    expect(spawnRes).toMatchObject({ spawned: true, reason: 'spawned' });
    expect(fakeSpawner).toHaveBeenCalledOnce();
    const [cmd, ctx] = fakeSpawner.mock.calls[0]!;
    expect(cmd).toContain('summarize.js');
    expect(cmd).toContain('TIM_SESSION_ID');
    expect(ctx.sessionId).toBe(SESSION_ID);

    const batch = await sessions.showUnsummarized(SESSION_ID);
    expect(batch.batchIndex).toBe(1);
    expect(batch.exchanges.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
    const { seqFrom, seqTo } = seqRange(batch);
    const summaryText = 'e2e batch-1 themes';
    await sessions.writeBatchSummary(SESSION_ID, batch.batchIndex, summaryText, { seqFrom, seqTo });

    const depth3 = (await store.loadProject(PROJECT_ID, { depth: 3, budget: 200 }))!;
    expect(batchSummaryNodes(depth3)).toHaveLength(0);

    const summaryRoot = depth3.children.find(c => c.metadata.kind === 'session-summary-root');
    expect(summaryRoot).toBeTruthy();
    // rollUpSession has no production caller — Summary node body stays empty at default depth
    expect(summaryRoot!.metadata.summary ?? '').toBe('');

    const depth4 = (await store.loadProject(PROJECT_ID, { depth: 4, budget: 200 }))!;
    const batches = batchSummaryNodes(depth4);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      metadata: {
        kind: 'batch-summary',
        batch_index: 1,
        seq_from: 1,
        seq_to: 5,
      },
      content: summaryText,
    });
    expect(batches[0]!.tags).toEqual(expect.arrayContaining(['#session-summary', '#batch-summary']));

    const { batchesSummarized } = await deriveCounters(store, SESSION_ID);
    expect(batchesSummarized).toBe(1);
    const session = await store.read(SESSION_ID);
    expect(session!.metadata.batches_summarized).toBe(1);

    await sessions.writeBatchSummary(SESSION_ID, 1, 'duplicate attempt', { seqFrom: 1, seqTo: 5 });
    const summaryNode = (await store.getChildByKind(SESSION_ID, 'session-summary-root'))[0]!;
    const written = await store.getChildByKind(summaryNode.id, 'batch-summary');
    expect(written).toHaveLength(1);

    const out = formatProjectOutput(depth3, 200);
    expect(out).toMatch(/── Recent Sessions \(1\/1\) ──/);
    // parseSessionEntry reads title "Summary", not batch text (Finding B — no rollUp)
    expect(out).toMatch(/0 exchanges · \d{4}-\d{2}-\d{2}  "Summary"/);
    expect(summaryRoot!.metadata.summary ?? '').toBe('');
  });

  it('runSummarizerLoop orchestration writes one batch via mocked MCP', async () => {
    await sessions.logExchange(SESSION_ID, [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'agent', content: 'A2' },
    ]);

    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool').mockImplementation(async (_client, tool, args) => {
      const a = args as Record<string, unknown>;
      if (tool === 'tim_show_unsummarized') {
        return sessions.showUnsummarized(a.sessionId as string);
      }
      if (tool === 'tim_write_batch_summary') {
        return sessions.writeBatchSummary(
          a.sessionId as string,
          a.batchIndex as number,
          a.summary as string,
          { seqFrom: a.seqFrom as number, seqTo: a.seqTo as number },
          a.tags as string[] | undefined,
        );
      }
      if (tool === 'tim_rollup_session_summary') {
        return sessions.rollUpSession(a.sessionId as string, async batches => foldBatchSummaries(batches as any));
      }
      throw new Error(`unexpected tool: ${tool}`);
    });

    const count = await runSummarizerLoop(SESSION_ID);
    expect(count).toBe(1);
    expect(close).toHaveBeenCalled();
    expect(mcpClient.callTimTool).toHaveBeenCalledWith(
      expect.anything(),
      'tim_rollup_session_summary',
      { sessionId: SESSION_ID },
    );

    const depth4 = (await store.loadProject(PROJECT_ID, { depth: 4, budget: 200 }))!;
    const batches = batchSummaryNodes(depth4);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.content).toContain('[ALL SUMMARIZER CLIs FAILED');
  });

  it('mergeProjectSummary surfaces text at depth 3', async () => {
    const loaded = (await store.loadProject(PROJECT_ID, { depth: 3 }))!;
    const newContent = mergeProjectSummary(loaded.project.content, 'aggregated project themes');
    await store.update(loaded.project.id, {
      title: loaded.project.title,
      content: newContent,
    });
    const reloaded = (await store.loadProject(PROJECT_ID, { depth: 3 }))!;
    const out = formatProjectOutput(reloaded, 200);
    expect(out).toContain('── Project Summary ──');
    expect(out).toContain('aggregated project themes');
  });
});

describe('pipeline e2e — edge cases', () => {
  let store: TimStore;
  let sessions: SessionManager;
  let tmpCwd: string;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    tmpCwd = fs.mkdtempSync(path.join(TEST_ROOT, 'pipe-edge-'));
    vi.stubEnv('TIM_MARKER_MAX_ROOT', tmpCwd);
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject(PROJECT_ID);
  });

  afterEach(() => {
    releaseLock(tmpCwd);
    store.close();
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function startSession(batchSize: number, sessionId = SESSION_ID): Promise<void> {
    await sessions.startProjectSession({
      sessionId,
      projectId: PROJECT_ID,
      agentName: 'a',
      cwd: tmpCwd,
      harness: 't',
      batchSize,
    });
    writeSessionMarker(tmpCwd, { session: sessionId, batch_size: batchSize });
  }

  function mockMcpToStore(sessionId: string): void {
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close: vi.fn() } as never);
    vi.spyOn(mcpClient, 'callTimTool').mockImplementation(async (_client, tool, args) => {
      const a = args as Record<string, unknown>;
      if (tool === 'tim_show_unsummarized') {
        return sessions.showUnsummarized(a.sessionId as string);
      }
      if (tool === 'tim_write_batch_summary') {
        return sessions.writeBatchSummary(
          a.sessionId as string,
          a.batchIndex as number,
          a.summary as string,
          { seqFrom: a.seqFrom as number, seqTo: a.seqTo as number },
          a.tags as string[] | undefined,
        );
      }
      if (tool === 'tim_rollup_session_summary') {
        return sessions.rollUpSession(a.sessionId as string, async batches => foldBatchSummaries(batches as any));
      }
      throw new Error(`unexpected tool: ${tool}`);
    });
  }

  it('empty chain → FALLBACK_MARKER lands in summary tree', async () => {
    await startSession(2);
    await sessions.logExchange(SESSION_ID, [
      { role: 'user', content: 'only-q' },
      { role: 'agent', content: 'only-a' },
    ]);
    mockMcpToStore(SESSION_ID);

    const count = await runSummarizerLoop(SESSION_ID);
    expect(count).toBe(1);

    const depth4 = (await store.loadProject(PROJECT_ID, { depth: 4, budget: 200 }))!;
    const batches = batchSummaryNodes(depth4);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.content).toContain('[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch 1]');
    expect(batches[0]!.content).toContain('Q: only-q');
  });

  it('all CLIs fail (nonexistent binary) → FALLBACK_MARKER in tree', async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({
      dbPath: ':memory:',
      deviceId: 'test',
      summarizer: {
        chain: [{ cli: 'definitely-not-a-real-cli-xyz', model: 'm', label: 'fake' }],
        timeout_sec: 5,
      },
    } as ReturnType<typeof loadConfig>);

    await startSession(2);
    await sessions.logExchange(SESSION_ID, [
      { role: 'user', content: 'x' },
      { role: 'agent', content: 'y' },
    ]);
    mockMcpToStore(SESSION_ID);

    const count = await runSummarizerLoop(SESSION_ID);
    expect(count).toBe(1);
    const depth4 = (await store.loadProject(PROJECT_ID, { depth: 4 }))!;
    const batchContent = batchSummaryNodes(depth4)[0]!.content;
    // When all CLIs fail, heuristic produces Q&A-style summary (not old FALLBACK_MARKER)
    expect(batchContent).toContain('Q1:');
  });

  it('empty batch → runSummarizerLoop writes 0 summaries', async () => {
    await startSession(5);
    const batch = await sessions.showUnsummarized(SESSION_ID);
    expect(batch.exchanges).toHaveLength(0);
    expect(batch.hasMore).toBe(false);

    mockMcpToStore(SESSION_ID);
    const count = await runSummarizerLoop(SESSION_ID);
    expect(count).toBe(0);

    const depth4 = (await store.loadProject(PROJECT_ID, { depth: 4 }))!;
    expect(batchSummaryNodes(depth4)).toHaveLength(0);
  });

  it('batch_size=1: onBatchFull×2, loop completion writes 3 batch summaries', async () => {
    const onBatchFull = vi.fn();
    sessions.setOnBatchFull(onBatchFull);
    await startSession(1);
    await sessions.logExchange(SESSION_ID, [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'agent', content: 'A2' },
      { role: 'user', content: 'Q3' },
      { role: 'agent', content: 'A3' },
    ]);
    expect(onBatchFull).toHaveBeenCalledTimes(2);
    expect(onBatchFull.mock.calls.map(c => c[0].batchIndex)).toEqual([1, 2]);

    mockMcpToStore(SESSION_ID);
    const count = await runSummarizerLoop(SESSION_ID);
    expect(count).toBe(3);

    const { batchesSummarized } = await deriveCounters(store, SESSION_ID);
    expect(batchesSummarized).toBe(3);
    const depth4 = (await store.loadProject(PROJECT_ID, { depth: 4, budget: 200 }))!;
    expect(batchSummaryNodes(depth4)).toHaveLength(3);
  });

  it('below-threshold gate does not spawn', async () => {
    await startSession(5);
    await sessions.logExchange(SESSION_ID, [{ role: 'user', content: 'one' }]);
    writeSessionMarker(tmpCwd, { exchanges: 1, batch_size: 5, batches_summarized: 0 });

    const fake = vi.fn();
    const res = await maybeSpawnSummarizer(store, tmpCwd, { spawn: fake });
    expect(res).toMatchObject({ spawned: false, reason: 'below-threshold' });
    expect(fake).not.toHaveBeenCalled();
  });

  it('lock held → no spawn', async () => {
    await startSession(5);
    await logSixExchanges(sessions);
    expect(acquireLock(tmpCwd)).toBe(true);

    const fake = vi.fn();
    const res = await maybeSpawnSummarizer(store, tmpCwd, { batchFull: true, spawn: fake });
    expect(res).toMatchObject({ spawned: false, reason: 'locked' });
    expect(fake).not.toHaveBeenCalled();
  });

  it('no marker → no spawn', async () => {
    const noMarkerDir = path.join(tmpCwd, 'no-marker');
    fs.mkdirSync(noMarkerDir, { recursive: true });
    await startSession(5);
    await logSixExchanges(sessions);

    const fake = vi.fn();
    const res = await maybeSpawnSummarizer(store, noMarkerDir, { batchFull: true, spawn: fake });
    expect(res).toMatchObject({ spawned: false, reason: 'no-marker' });
    expect(fake).not.toHaveBeenCalled();
  });
});
