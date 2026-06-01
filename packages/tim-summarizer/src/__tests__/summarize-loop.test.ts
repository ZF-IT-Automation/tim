import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as mcpClient from '../mcp-client.js';
import { generateSummaryHeuristic } from '../generate-summary.js';
import { runSummarizerLoop } from '../summarize.js';

describe('runSummarizerLoop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one batch summary then stops when hasMore is false', async () => {
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
        summary: generateSummaryHeuristic(batch),
        seqFrom: 1,
        seqTo: 1,
      }),
    );
    expect(close).toHaveBeenCalled();
  });
});
