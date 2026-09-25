import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as mcpClient from '../mcp-client.js';
import * as generateSummary from '../generate-summary.js';
import { runSummarizerLoop } from '../summarize.js';
import type { UnsummarizedBatch, UnsummarizedExchange } from '../mcp-client.js';

function logDir(): string {
  return path.join(os.tmpdir(), 'tim-jev-substance-gate');
}

vi.mock('tim-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tim-core')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      dbPath: ':memory:',
      deviceId: 'test',
      summarizer: { chain: [{ cli: 'must-not-run', model: 'x' }], timeout_sec: 5 },
    })),
    getTimDir: vi.fn(() => {
      const dir = path.join(os.tmpdir(), 'tim-jev-substance-gate');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }),
    getConfigPath: vi.fn(() => path.join(os.tmpdir(), 'tim-jev-substance-gate', 'config.json')),
  };
});

function exchange(seq: number, user: string, agent: string): UnsummarizedExchange {
  return { seq, userId: `u${seq}`, userContent: user, agentId: `a${seq}`, agentContent: agent };
}

function batchOf(exchanges: UnsummarizedExchange[], overrides: Partial<UnsummarizedBatch> = {}): UnsummarizedBatch {
  return {
    sessionId: 'sess-gate',
    summaryNodeId: 's',
    exchangesNodeId: 'e',
    batchIndex: 1,
    batchSize: exchanges.length,
    exchanges,
    hasMore: false,
    previousSummaries: [],
    sessionMeta: {
      title: 'gate session',
      project: 'P0063',
      tool: 'cursor',
      date: '2026-09-25T08:00:00.000Z',
      task_summary: 'wire the substance gate',
    },
    ...overrides,
  };
}

function scoreReply(probabilities: Record<string, number>): string {
  return JSON.stringify({
    answers: {
      substance: { type: 'score', score: 0, probabilities, confidence: 0.5 },
    },
  });
}

function writeArgs(): Record<string, unknown>[] {
  return vi.mocked(mcpClient.callTimTool).mock.calls
    .filter(([, tool]) => tool === 'tim_write_batch_summary')
    .map(([, , args]) => args as Record<string, unknown>);
}

async function runBatch(
  batch: UnsummarizedBatch,
  reply: Response,
): Promise<{ fetchSpy: ReturnType<typeof vi.fn>; generateSpy: ReturnType<typeof vi.spyOn> }> {
  const fetchSpy = vi.fn(async () => reply);
  vi.stubGlobal('fetch', fetchSpy);
  const generateSpy = vi.spyOn(generateSummary, 'generateSummaryDetailed').mockResolvedValue({
    text: 'Did the work\nSUBSTANCE: real',
    status: 'ok',
  });
  vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close: vi.fn() } as never);
  vi.spyOn(mcpClient, 'callTimTool')
    .mockResolvedValueOnce(batch)
    .mockResolvedValueOnce({ id: 'written' })
    .mockResolvedValueOnce({ id: 'summary-root', content: 'rolled' });
  await runSummarizerLoop(batch.sessionId);
  return { fetchSpy, generateSpy };
}

function requestBody(fetchSpy: ReturnType<typeof vi.fn>): { state: string; questions: Record<string, unknown> } {
  const init = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '{}');
}

describe('Jev substance gate before the summarizer LLM', () => {
  beforeEach(() => {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(path.join(logDir(), 'summarizer.log'), '');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.JEV_API_KEY;
  });

  afterEach(() => {
    delete process.env.JEV_API_KEY;
    vi.unstubAllGlobals();
  });

  it('skips the LLM when argmax is trivial and P(trivial) is 0.8', async () => {
    process.env.JEV_API_KEY = 'test-key';
    const agent = `AGENT_MARKER ${'x'.repeat(2000)}`;
    const batch = batchOf([exchange(1, 'user line only', agent)]);
    const { fetchSpy, generateSpy } = await runBatch(
      batch,
      new Response(scoreReply({ '0': 0.8, '1': 0.1, '2': 0.1 })),
    );

    expect(generateSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = requestBody(fetchSpy);
    expect(body.state).toContain('AGENT_MARKER');
    expect(body.state).not.toContain('x'.repeat(1600));
    expect(body.state).toContain('user line only');
    expect(body.state).toContain('P0063');
    expect(body.questions.substance).toEqual({
      type: 'score',
      instructions: 'How substantive is this session for future work?',
      criteria: ['trivial', 'some substance', 'major'],
    });
    expect(writeArgs()[0]).toEqual(expect.objectContaining({
      sessionId: 'sess-gate',
      substance: 'none',
      summary: expect.stringMatching(/trivial/i),
    }));
    const log = fs.readFileSync(path.join(logDir(), 'summarizer.log'), 'utf-8');
    expect(log).toContain('sess-gate');
    expect(log).toContain('0.8');
  });

  it('calls the LLM when P(trivial) is 0.6', async () => {
    process.env.JEV_API_KEY = 'test-key';
    const batch = batchOf([exchange(1, 'user', 'agent reply')]);
    const { generateSpy } = await runBatch(
      batch,
      new Response(scoreReply({ '0': 0.6, '1': 0.3, '2': 0.1 })),
    );
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(writeArgs()[0]).toEqual(expect.objectContaining({
      summary: 'Did the work',
      substance: 'real',
    }));
  });

  it('calls the LLM when argmax is some substance', async () => {
    process.env.JEV_API_KEY = 'test-key';
    const batch = batchOf([exchange(1, 'user', 'agent reply')]);
    const { generateSpy } = await runBatch(
      batch,
      new Response(scoreReply({ '0': 0.2, '1': 0.7, '2': 0.1 })),
    );
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('calls the LLM when Jev returns null', async () => {
    process.env.JEV_API_KEY = 'test-key';
    const batch = batchOf([exchange(1, 'user', 'agent reply')]);
    const { fetchSpy, generateSpy } = await runBatch(batch, new Response('down', { status: 503 }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('does not ask Jev about a session with more than one batch or more than two exchanges', async () => {
    process.env.JEV_API_KEY = 'test-key';
    const fetchSpy = vi.fn(async () => new Response(scoreReply({ '0': 0.99, '1': 0.01, '2': 0 })));
    vi.stubGlobal('fetch', fetchSpy);
    const generateSpy = vi.spyOn(generateSummary, 'generateSummaryDetailed').mockResolvedValue({
      text: 'Did the work\nSUBSTANCE: real',
      status: 'ok',
    });
    const first = batchOf([exchange(1, 'user-a', 'agent-a')], { hasMore: true, batchIndex: 1 });
    const second = batchOf([exchange(2, 'commit', 'pushed')], {
      hasMore: false, batchIndex: 2, previousSummaries: ['Did the work'],
    });
    const three = batchOf([exchange(1, 'a', 'b'), exchange(2, 'c', 'd'), exchange(3, 'e', 'f')], { sessionId: 'sess-3' });
    vi.spyOn(mcpClient, 'connectTimMcp').mockResolvedValue({ close: vi.fn() } as never);
    vi.spyOn(mcpClient, 'callTimTool')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ id: 'w1' })
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce({ id: 'w2' })
      .mockResolvedValueOnce({ id: 'summary-root' })
      .mockResolvedValueOnce(three)
      .mockResolvedValueOnce({ id: 'w3' })
      .mockResolvedValueOnce({ id: 'summary-root-3' });

    await runSummarizerLoop('sess-gate');
    await runSummarizerLoop('sess-3');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(generateSpy).toHaveBeenCalledTimes(3);
  });
});
