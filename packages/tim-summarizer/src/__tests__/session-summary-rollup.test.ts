import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as mcpClient from '../mcp-client.js';
import { runSummarizerLoop } from '../summarize.js';

vi.mock('tim-core', () => ({
  loadConfig: vi.fn(() => ({
    dbPath: ':memory:',
    deviceId: 'test',
    summarizer: { chain: [], timeout_sec: 5 },
  })),
}));

const emptyBatch = {
  sessionId: 'sess-rollup',
  summaryNodeId: 's',
  exchangesNodeId: 'e',
  batchIndex: 1,
  batchSize: 2,
  exchanges: [],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: {},
};

const oneExchangeBatch = {
  sessionId: 'sess-rollup',
  summaryNodeId: 's',
  exchangesNodeId: 'e',
  batchIndex: 1,
  batchSize: 2,
  exchanges: [{ seq: 1, userId: 'u', userContent: 'Q', agentId: 'a', agentContent: 'A' }],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: {},
};

describe('session-summary rollup via MCP', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rollup called after write', async () => {
    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(oneExchangeBatch)
      .mockResolvedValueOnce({ id: 'written' })
      .mockResolvedValueOnce({ id: 'summary-root', content: 'rolled up' });

    const count = await runSummarizerLoop('sess-rollup');
    expect(count).toBe(1);
    expect(mcpClient.callTimTool).toHaveBeenCalledWith(
      expect.anything(),
      'tim_rollup_session_summary',
      { sessionId: 'sess-rollup' },
    );
    expect(close).toHaveBeenCalled();
  });

  it('rollup is called even when written=0 (orphaned-batch coverage)', async () => {
    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(emptyBatch)
      .mockResolvedValueOnce({ id: 'summary-root', content: 'rolled up' });

    const count = await runSummarizerLoop('sess-rollup');
    expect(count).toBe(0);
    expect(mcpClient.callTimTool).toHaveBeenCalledWith(
      expect.anything(),
      'tim_rollup_session_summary',
      { sessionId: 'sess-rollup' },
    );
    expect(close).toHaveBeenCalled();
  });

  it('rollup with multiple batches', async () => {
    const batch1 = {
      ...oneExchangeBatch,
      batchIndex: 1,
      hasMore: true,
    };
    const batch2 = {
      ...oneExchangeBatch,
      batchIndex: 2,
      exchanges: [{ seq: 2, userId: 'u2', userContent: 'Q2', agentId: 'a2', agentContent: 'A2' }],
      hasMore: false,
    };

    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce({ id: 'written-1' })
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce({ id: 'written-2' })
      .mockResolvedValueOnce({ id: 'summary-root', content: 'batch1\n\n---\n\nbatch2' });

    const count = await runSummarizerLoop('sess-rollup');
    expect(count).toBe(2);

    const writeCalls = vi.mocked(mcpClient.callTimTool).mock.calls.filter(
      ([, tool]) => tool === 'tim_write_batch_summary',
    );
    expect(writeCalls).toHaveLength(2);

    expect(mcpClient.callTimTool).toHaveBeenCalledWith(
      expect.anything(),
      'tim_rollup_session_summary',
      { sessionId: 'sess-rollup' },
    );
  });
});
