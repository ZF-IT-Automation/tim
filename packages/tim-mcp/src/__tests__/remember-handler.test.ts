import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { getTimDir } from 'tim-core';
import { TimStore } from 'tim-store';
import {
  handleTimRemember,
  rememberDeps,
  spawnRememberSubprocess,
  type RankedCandidate,
  type RerankResult,
} from '../remember-handler.js';

/** Mirrors server.ts TimRememberSchema — validation tests must stay in sync. */
const TimRememberSchema = z.object({
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(20).optional().default(5),
  minConfidence: z.number().min(0).max(1).optional().default(0.3),
  includeBatchSummaries: z.boolean().optional().default(true),
  searchType: z.enum(['fts']).optional().default('fts'),
  projectScope: z.string().regex(/^P\d{4}$/).optional(),
});

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

function countNewLogLines(beforeSize: number): number {
  if (!fs.existsSync(rememberLogPath)) return 0;
  const content = fs.readFileSync(rememberLogPath, 'utf8').slice(beforeSize);
  return content.split('\n').filter((line) => line.trim().length > 0).length;
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

describe('TimRememberSchema validation (F4)', () => {
  it('rejects_empty_query', () => {
    const parsed = TimRememberSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('query'))).toBe(true);
    }
  });

  it('rejects_oversized_query', () => {
    const parsed = TimRememberSchema.safeParse({ query: 'x'.repeat(501) });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('query'))).toBe(true);
    }
  });
});

describe('handleTimRemember', () => {
  it('returns_empty_on_no_hits (F3)', async () => {
    const start = Date.now();
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
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('latency_below_500ms_on_no_hits (P3)', async () => {
    const start = Date.now();
    await handleTimRemember(store, {
      query: 'xyz123nonsense',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });
    expect(Date.now() - start).toBeLessThan(500);
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

  it('falls_back_on_chain_exhaustion', async () => {
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

  it('falls_back_on_hard_timeout', async () => {
    const { entryIds } = await seedProjectEntries('P0910', 5, 'timeoutterm');

    spawnMock.mockResolvedValue({
      ranked: null,
      model: 'timeout',
      tokensIn: 0,
      tokensOut: 0,
      fallback: 'timeout',
    });

    const result = await handleTimRemember(store, {
      query: 'timeoutterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.meta.fallback_used).toBe('timeout');
    expect(result.results.some((item) => entryIds.includes(item.node_id))).toBe(true);
  });

  it.skip('falls_back_on_chain_timeout', () => {
    // N/A in handler unit tests — per-chain timeout lives in remember-query.ts tryCli loop.
    // Covered indirectly via remember-query.test.ts chain iteration tests.
  });

  it('falls_back_on_invalid_json', async () => {
    const { entryIds } = await seedProjectEntries('P0911', 4, 'invalidjsonterm');

    spawnMock.mockResolvedValue({
      ranked: null,
      model: 'invalid-json',
      tokensIn: 0,
      tokensOut: 0,
      fallback: 'invalid_json',
    });

    const result = await handleTimRemember(store, {
      query: 'invalidjsonterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.meta.fallback_used).toBe('invalid_json');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some((item) => entryIds.includes(item.node_id))).toBe(true);
  });

  it('falls_back_on_empty_rerank', async () => {
    const { entryIds } = await seedProjectEntries('P0912', 4, 'emptyrerankterm');

    spawnMock.mockResolvedValue({
      ranked: [],
      model: 'test/mock',
      tokensIn: 50,
      tokensOut: 10,
      fallback: 'none',
    });

    const result = await handleTimRemember(store, {
      query: 'emptyrerankterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.meta.fallback_used).toBe('all_chain_failed');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some((item) => entryIds.includes(item.node_id))).toBe(true);
  });

  it.skip('handles_db_lock_during_verify', () => {
    // N/A in CI — SQLite busy/lock during entryExistsBatch hard to reproduce deterministically
    // with in-memory store. Handler delegates to store.entryExistsBatch; lock behavior is
    // store-layer concern.
  });

  it('flags_suspiciously_fast_rerank', async () => {
    await seedProjectEntries('P0913', 3, 'fastrerankterm');
    const beforeSize = fs.existsSync(rememberLogPath) ? fs.statSync(rememberLogPath).size : 0;

    spawnMock.mockImplementation(async () => successRerank([]));

    await handleTimRemember(store, {
      query: 'fastrerankterm',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    const logTail = fs.readFileSync(rememberLogPath, 'utf8').slice(beforeSize);
    expect(logTail).toContain('suspiciously_fast=true');
  });

  it('filters_hallucinated_ids (F5)', async () => {
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

  it('filters_schema_violations (F12/S3)', async () => {
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

  it('respects minConfidence (F8)', async () => {
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

  it('respects topK (F7)', async () => {
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

  it('respects projectScope (F6)', async () => {
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

  it('happy_path_returns_ranked_results (F1)', async () => {
    const { entryIds } = await seedProjectEntries('P0914', 5, 'recallhappy');

    spawnMock.mockResolvedValue(
      successRerank(
        entryIds.map((id, index) => ({
          node_id: id,
          confidence: 0.92 - index * 0.08,
          reasoning: `lockfile match ${index}`,
        })),
      ),
    );

    const start = Date.now();
    const result = await handleTimRemember(store, {
      query: 'recallhappy',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results.length).toBeGreaterThanOrEqual(3);
    expect(result.results.length).toBeLessThanOrEqual(5);
    expect(result.results.every((item) => item.relevance >= 0.5)).toBe(true);
    expect(result.meta.fallback_used).toBe('none');
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('happy_path_high_confidence_hit (F2)', async () => {
    const { entryIds } = await seedProjectEntries('P0915', 3, 'telegrambot');

    spawnMock.mockResolvedValue(
      successRerank([
        { node_id: entryIds[0]!, confidence: 0.91, reasoning: 'Telegram bot direct match' },
        { node_id: entryIds[1]!, confidence: 0.55, reasoning: 'related' },
      ]),
    );

    const result = await handleTimRemember(store, {
      query: 'telegrambot',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });

    expect(result.results.some((item) => item.relevance >= 0.7)).toBe(true);
    expect(result.meta.fallback_used).toBe('none');
  });

  it('latency_below_3s_for_typical_query (P1)', async () => {
    const { entryIds } = await seedProjectEntries('P0916', 5, 'typicalquery');

    spawnMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                successRerank(
                  entryIds.map((id, index) => ({
                    node_id: id,
                    confidence: 0.85 - index * 0.05,
                    reasoning: `typical ${index}`,
                  })),
                ),
              ),
            100,
          );
        }),
    );

    const start = Date.now();
    await handleTimRemember(store, {
      query: 'typicalquery',
      topK: 5,
      minConfidence: 0.3,
      includeBatchSummaries: false,
      searchType: 'fts',
    });
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('audit_log_written_per_call (P8)', async () => {
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
    expect(countNewLogLines(beforeSize)).toBe(1);
    const logTail = fs.readFileSync(rememberLogPath, 'utf8').slice(beforeSize);
    expect(logTail).toContain('query="auditterm"');
    expect(logTail).toMatch(/latency_ms=\d+/);
  });
});

describe('remember-query read-only architecture (S1)', () => {
  it('subprocess source has no TIM write/MCP client imports', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const sourcePath = path.join(repoRoot, 'packages', 'tim-summarizer', 'src', 'remember-query.ts');
    const output = execSync(
      `grep -E "mcp-client|callTimTool|tim_write|tim_update" "${sourcePath}" || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(output).toBe('');
  });
});
