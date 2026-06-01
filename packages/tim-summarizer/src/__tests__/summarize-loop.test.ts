import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as mcpClient from '../mcp-client.js';
import { runSummarizerLoop } from '../summarize.js';
import { loadConfig } from 'tim-core';

describe('runSummarizerLoop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn({ loadConfig }, 'loadConfig').mockReturnValue({
      dbPath: ':memory:',
      deviceId: 'test',
      summarizer: { chain: [], timeout_sec: 5 },
    });
  });

  it('writes fallback when chain is empty', async () => {
    const batch = {
      sessionId: 'loop',
      summaryNodeId: 's',
      exchangesNodeId: 'e',
      batchIndex: 1,
      batchSize: 2,
      exchanges: [
        { seq: 1, userId: 'u', userContent: 'Q', agentId: 'a', agentContent: 'A' },
      ],
      hasMore: false,
      previousSummaries: [],
      sessionMeta: {},
    };

    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce({ id: 'written' });

    const count = await runSummarizerLoop('loop');
    expect(count).toBe(1);
    expect(mcpClient.callTimTool).toHaveBeenCalledWith(
      expect.anything(),
      'tim_write_batch_summary',
      expect.objectContaining({
        sessionId: 'loop',
        batchIndex: 1,
        summary: `[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch 1]\nQ: Q`,
        seqFrom: 1,
        seqTo: 1,
      }),
    );
    expect(close).toHaveBeenCalled();
  });
});
