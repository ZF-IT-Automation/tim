import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTimDir } from 'tim-core';
import { TimStore } from 'tim-store';
import {
  handleTimRemember,
  rememberDeps,
  spawnRememberSubprocess,
  type RankedCandidate,
  type RerankResult,
} from '../remember-handler.js';

let store: TimStore;
let spawnMock: ReturnType<typeof vi.fn>;
const rememberLogPath = path.join(getTimDir(), 'remember.log');

function successRerank(ranked: RankedCandidate[]): RerankResult {
  return {
    ranked,
    model: 'test/mock',
    tokensIn: 100,
    tokensOut: 40,
    fallback: 'none',
  };
}

async function seedProjectEntries(
  projectLabel: string,
  count: number,
  keyword: string,
): Promise<{ projectId: string; entryIds: string[] }> {
  const project = await store.createProject(projectLabel);
  const entryIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const entry = await store.write(`${keyword} searchable content item ${i}`, {
      parentId: project.id,
      title: `${keyword} title ${i}`,
    });
    entryIds.push(entry.id);
  }
  return { projectId: project.id, entryIds };
}

beforeEach(() => {
  store = new TimStore(':memory:');
  spawnMock = vi.fn().mockResolvedValue({
    ranked: null,
    model: 'test/unconfigured',
    tokensIn: 0,
    tokensOut: 0,
    fallback: 'all_chain_failed',
  } satisfies RerankResult);
  rememberDeps.spawnRememberSubprocess = spawnMock;
});

afterEach(() => {
  rememberDeps.spawnRememberSubprocess = spawnRememberSubprocess;
  store.close();
  vi.restoreAllMocks();
});

describe('handleTimRemember', () => {
  it('handles empty FTS results', async () => {
    const result = await handleTimRemember(store, {
      query: 'xyz123nonsense',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results).toEqual([]);
    expect(result.meta.fallback_used).toBe('no_fts_hits');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('caps candidates at 30 before rerank', async () => {
    await seedProjectEntries('P0901', 50, 'captest');

    await handleTimRemember(store, {
      query: 'captest',
      topK: 15,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const input = spawnMock.mock.calls[0]![0] as { candidates: unknown[] };
    expect(input.candidates.length).toBe(30);
  });

  it('returns FTS-only fallback when subprocess fails', async () => {
    const { entryIds } = await seedProjectEntries('P0902', 5, 'fallbackterm');

    spawnMock.mockResolvedValue({
      ranked: null,
      model: 'chain-exhausted',
      tokensIn: 0,
      tokensOut: 0,
      fallback: 'all_chain_failed',
    });

    const result = await handleTimRemember(store, {
      query: 'fallbackterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.meta.fallback_used).toBe('all_chain_failed');
    expect(result.results.some((item) => entryIds.includes(item.node_id))).toBe(true);
  });

  it('filters hallucinated IDs', async () => {
    const { entryIds } = await seedProjectEntries('P0903', 3, 'halluterm');

    spawnMock.mockResolvedValue(
      successRerank([
        { node_id: entryIds[0]!, confidence: 0.95, reasoning: 'real hit' },
        { node_id: '01FAKEFAKEFAKEFAKEFAKEFAKEFA', confidence: 0.99, reasoning: 'fake hit' },
        { node_id: entryIds[1]!, confidence: 0.8, reasoning: 'also real' },
      ]),
    );

    const result = await handleTimRemember(store, {
      query: 'halluterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results.map((item) => item.node_id)).toEqual(
      expect.arrayContaining([entryIds[0], entryIds[1]]),
    );
    expect(result.results.some((item) => item.node_id.startsWith('01FAKE'))).toBe(false);
    expect(result.meta.dropped_hallucinated).toBe(1);
  });

  it('filters schema violations', async () => {
    const { entryIds } = await seedProjectEntries('P0904', 2, 'schematerm');

    spawnMock.mockResolvedValue({
      ranked: [
        { node_id: entryIds[0]!, confidence: 0.9, reasoning: 'valid' },
        { node_id: entryIds[1]!, confidence: 1.5, reasoning: 'invalid confidence' },
        { node_id: 'short', confidence: 0.7, reasoning: 'ok' } as RankedCandidate,
      ],
      model: 'test/mock',
      tokensIn: 10,
      tokensOut: 10,
      fallback: 'none',
    });

    const result = await handleTimRemember(store, {
      query: 'schematerm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.node_id).toBe(entryIds[0]);
  });

  it('respects minConfidence', async () => {
    const { entryIds } = await seedProjectEntries('P0905', 2, 'confidenceterm');

    spawnMock.mockResolvedValue(
      successRerank([
        { node_id: entryIds[0]!, confidence: 0.2, reasoning: 'low' },
        { node_id: entryIds[1]!, confidence: 0.85, reasoning: 'high' },
      ]),
    );

    const result = await handleTimRemember(store, {
      query: 'confidenceterm',
      topK: 5,
      minConfidence: 0.5,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.node_id).toBe(entryIds[1]);
    expect(result.results[0]!.relevance).toBe(0.85);
  });

  it('respects topK', async () => {
    const { entryIds } = await seedProjectEntries('P0906', 6, 'topkterm');

    spawnMock.mockResolvedValue(
      successRerank(
        entryIds.map((id, index) => ({
          node_id: id,
          confidence: 0.9 - index * 0.01,
          reasoning: `rank ${index}`,
        })),
      ),
    );

    const result = await handleTimRemember(store, {
      query: 'topkterm',
      topK: 3,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results).toHaveLength(3);
  });

  it('respects projectScope', async () => {
    await seedProjectEntries('P0907', 3, 'scopedalpha');
    await seedProjectEntries('P0908', 3, 'scopedalpha');

    spawnMock.mockResolvedValue({
      ranked: null,
      model: 'chain-exhausted',
      tokensIn: 0,
      tokensOut: 0,
      fallback: 'all_chain_failed',
    });

    const result = await handleTimRemember(store, {
      query: 'scopedalpha',
      topK: 10,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
      projectScope: 'P0907',
    });

    expect(result.results.length).toBe(3);
    for (const item of result.results) {
      expect(store.getProjectLabel(item.node_id)).toBe('P0907');
    }
  });

  it('audit log written', async () => {
    await seedProjectEntries('P0909', 2, 'auditterm');
    const beforeSize = fs.existsSync(rememberLogPath) ? fs.statSync(rememberLogPath).size : 0;

    spawnMock.mockResolvedValue({
      ranked: null,
      model: 'chain-exhausted',
      tokensIn: 0,
      tokensOut: 0,
      fallback: 'all_chain_failed',
    });

    await handleTimRemember(store, {
      query: 'auditterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(fs.existsSync(rememberLogPath)).toBe(true);
    const logTail = fs.readFileSync(rememberLogPath, 'utf8').slice(beforeSize);
    expect(logTail).toContain('query="auditterm"');
    expect(logTail).toMatch(/latency_ms=\d+/);
  });
});

describe('remember-query read-only architecture', () => {
  it('subprocess source has no TIM write/MCP client imports', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const sourcePath = path.join(repoRoot, 'packages', 'tim-summarizer', 'src', 'remember-query.ts');
    const output = execSync(
      `grep -rn "mcp-client\\|callTimTool\\|tim_write\\|tim_update" "${sourcePath}" || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(output).toBe('');
  });
});
