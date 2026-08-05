import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as mcpClient from '../mcp-client.js';
import {
  generateSummary,
  generateSummaryDetailed,
  noChainHint,
  FALLBACK_MARKER,
} from '../generate-summary.js';
import { runSummarizerLoop } from '../summarize.js';
import type { UnsummarizedBatch } from '../mcp-client.js';

const CONFIG_PATH = '/fake-home/.tim/config.json';

vi.mock('tim-core', () => ({
  loadConfig: vi.fn(() => ({
    dbPath: ':memory:',
    deviceId: 'test',
    summarizer: { chain: [], timeout_sec: 5 },
  })),
  getTimDir: vi.fn(() => fs.mkdtempSync(path.join(os.tmpdir(), 'tim-log-'))),
  getConfigPath: vi.fn(() => CONFIG_PATH),
}));

const batch: UnsummarizedBatch = {
  sessionId: 'sess-degraded',
  summaryNodeId: 's',
  exchangesNodeId: 'e',
  batchIndex: 1,
  batchSize: 2,
  exchanges: [{ seq: 1, userId: 'u', userContent: 'Q', agentId: 'a', agentContent: 'A' }],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: {},
};

describe('degraded summarizer outcomes are observable', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('noChainHint names the config path and the key to add', () => {
    const hint = noChainHint();
    expect(hint).toContain(CONFIG_PATH);
    expect(hint).toContain('"summarizer"');
    expect(hint).toContain('chain');
  });

  it('missing chain reports status no-chain and logs an actionable message', async () => {
    const onError = vi.fn();
    const result = await generateSummaryDetailed(batch, onError);

    expect(result).toEqual({ text: FALLBACK_MARKER, status: 'no-chain' });
    // Distinct from the generic per-CLI failure text: it names the config file.
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(CONFIG_PATH);
    // A missing chain is not a per-CLI failure, so it does not go through onError.
    expect(onError).not.toHaveBeenCalled();
  });

  it('generateSummary keeps its string contract', async () => {
    await expect(generateSummary(batch)).resolves.toBe(FALLBACK_MARKER);
  });

  it('runSummarizerLoop reports each degraded batch to its caller', async () => {
    const close = vi.fn();
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce({ id: 'written' })
      .mockResolvedValueOnce({ id: 'summary-root' });

    const onDegraded = vi.fn();
    const count = await runSummarizerLoop('sess-degraded', { onDegraded });

    expect(count).toBe(1);
    expect(onDegraded).toHaveBeenCalledWith({ batchIndex: 1, status: 'no-chain' });
  });
});
