import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as mcpClient from '../mcp-client.js';
import * as generateSummary from '../generate-summary.js';
import { runSummarizerLoop } from '../summarize.js';

vi.mock('tim-core', () => ({
  loadConfig: vi.fn(() => ({
    dbPath: ':memory:',
    deviceId: 'test',
    summarizer: { chain: [{ cli: 'must-not-run', model: 'x' }], timeout_sec: 5 },
  })),
  getTimDir: vi.fn(() => os.tmpdir()),
  getConfigPath: vi.fn(() => path.join(os.tmpdir(), 'config.json')),
}));

describe('empty-user-turn pre-filter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips summarizer CLI when every user turn is whitespace-only', async () => {
    const batch = {
      sessionId: 'auto',
      summaryNodeId: 's',
      exchangesNodeId: 'e',
      batchIndex: 1,
      batchSize: 2,
      exchanges: [
        { seq: 1, userId: 'u', userContent: '   ', agentId: 'a', agentContent: 'watchdog' },
        { seq: 2, userId: 'u2', userContent: '\n', agentId: 'a2', agentContent: 'ok' },
      ],
      hasMore: false,
      previousSummaries: [],
      sessionMeta: {},
    };

    const generateSpy = vi.spyOn(generateSummary, 'generateSummaryDetailed');
    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce({ id: 'written' })
      .mockResolvedValueOnce({ id: 'summary-root', content: 'rolled' });

    const count = await runSummarizerLoop('auto');
    expect(count).toBe(1);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(mcpClient.callTimTool).toHaveBeenCalledWith(
      expect.anything(),
      'tim_write_batch_summary',
      expect.objectContaining({
        summary: 'No user content (automation).',
        substance: 'none',
      }),
    );
  });
});
