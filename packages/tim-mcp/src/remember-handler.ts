import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  getTimDir,
  loadConfig,
  resolveActiveSessionId,
  type Entry,
} from 'tim-core';
import type { TimStore } from 'tim-store';
import { dedupeById, expandQueryVariants } from './query-variants.js';

export interface TimRememberOptions {
  query: string;
  topK: number;
  minConfidence: number;
  includeBatchSummaries: boolean;
  searchType: 'fts';
  projectScope?: string;
}

export interface TimRememberResultItem {
  node_id: string;
  title: string;
  relevance: number;
  excerpt: string;
  parents: Array<{ id: string; title: string }>;
  reasoning?: string;
}

export type RememberFallbackUsed =
  | 'none'
  | 'timeout'
  | 'error'
  | 'empty_query'
  | 'no_fts_hits'
  | 'all_chain_failed'
  | 'invalid_json';

export interface TimRememberResult {
  query: string;
  results: TimRememberResultItem[];
  meta: {
    latency_ms: number;
    candidates_fts: number;
    candidates_after_rerank: number;
    dropped_hallucinated: number;
    sub_process_model: string;
    sub_process_tokens_in: number;
    sub_process_tokens_out: number;
    fallback_used: RememberFallbackUsed;
  };
}

export interface RememberCandidate {
  id: string;
  title: string;
  excerpt: string;
  parents: Array<{ id: string; title: string }>;
}

export interface RankedCandidate {
  node_id: string;
  confidence: number;
  reasoning: string;
}

export type RerankFallback =
  | 'none'
  | 'timeout'
  | 'error'
  | 'all_chain_failed'
  | 'invalid_json';

export interface RerankResult {
  ranked: RankedCandidate[] | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  fallback: RerankFallback;
}

export interface RememberQueryInput {
  query: string;
  candidates: RememberCandidate[];
  batchSummaries?: Array<{ id: string; title: string; excerpt: string }>;
  topK: number;
}

export function appendRememberLog(line: string): void {
  try {
    const logPath = path.join(getTimDir(), 'remember.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore write failures
  }
}

export async function getProjectParent(
  store: TimStore,
  entryId: string,
): Promise<Array<{ id: string; title: string }>> {
  const entry = await store.read(entryId);
  if (!entry) return [];

  let currentId: string | null = entry.parentId;
  for (let depth = 0; depth < 5 && currentId; depth++) {
    const parent = await store.read(currentId);
    if (!parent) break;
    if (parent.metadata?.kind === 'project') {
      const label =
        typeof parent.metadata.label === 'string'
          ? parent.metadata.label
          : parent.title;
      return [{ id: parent.id, title: label.slice(0, 80) }];
    }
    currentId = parent.parentId;
  }
  return [];
}

function filterByProjectScope(
  store: TimStore,
  entries: Entry[],
  projectScope?: string,
): Entry[] {
  if (!projectScope) return entries;
  return entries.filter((entry) => store.getProjectLabel(entry.id) === projectScope);
}

function filterValidRanked(ranked: RankedCandidate[]): RankedCandidate[] {
  return ranked.filter(
    (item) =>
      typeof item.node_id === 'string' &&
      typeof item.confidence === 'number' &&
      item.confidence >= 0 &&
      item.confidence <= 1 &&
      typeof item.reasoning === 'string',
  );
}

function buildEmptyResult(
  opts: TimRememberOptions,
  startTime: number,
  fallback: RememberFallbackUsed,
  candidatesFts = 0,
): TimRememberResult {
  return {
    query: opts.query,
    results: [],
    meta: {
      latency_ms: Date.now() - startTime,
      candidates_fts: candidatesFts,
      candidates_after_rerank: 0,
      dropped_hallucinated: 0,
      sub_process_model: '',
      sub_process_tokens_in: 0,
      sub_process_tokens_out: 0,
      fallback_used: fallback,
    },
  };
}

function toOutputShape(
  ranked: RankedCandidate,
  candidatesMap: Map<string, RememberCandidate>,
): TimRememberResultItem {
  const candidate = candidatesMap.get(ranked.node_id);
  return {
    node_id: ranked.node_id,
    title: candidate?.title ?? '',
    relevance: ranked.confidence,
    excerpt: candidate?.excerpt ?? '',
    parents: candidate?.parents ?? [],
    reasoning: ranked.reasoning,
  };
}

function ftsHitToResultItem(
  hit: Entry,
  candidate?: RememberCandidate,
): TimRememberResultItem {
  return {
    node_id: hit.id,
    title: candidate?.title ?? hit.title.slice(0, 80),
    relevance: 0,
    excerpt: candidate?.excerpt ?? (hit.content || '').slice(0, 200),
    parents: candidate?.parents ?? [],
  };
}

async function prefetchCandidates(
  store: TimStore,
  hits: Entry[],
): Promise<RememberCandidate[]> {
  return Promise.all(
    hits.map(async (hit) => {
      const entry = await store.read(hit.id);
      if (!entry) {
        return {
          id: hit.id,
          title: hit.title.slice(0, 80),
          excerpt: (hit.content || '').slice(0, 200),
          parents: [],
        };
      }
      return {
        id: entry.id,
        title: entry.title.slice(0, 80),
        excerpt: (entry.content || '').slice(0, 200),
        parents: await getProjectParent(store, entry.id),
      };
    }),
  );
}

function spawnRememberSubprocessImpl(
  input: RememberQueryInput,
  hardTimeoutMs: number,
): Promise<RerankResult> {
  return new Promise((resolve) => {
    const subprocessPath = path.resolve(
      __dirname,
      '..',
      '..',
      'tim-summarizer',
      'dist',
      'remember-query.js',
    );
    const child = spawn('node', [subprocessPath], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, hardTimeoutMs);

    child.on('close', (code) => {
      clearTimeout(hardTimer);
      if (timedOut) {
        resolve({
          ranked: null,
          model: 'timeout',
          tokensIn: 0,
          tokensOut: 0,
          fallback: 'timeout',
        });
        return;
      }
      if (code !== 0) {
        appendRememberLog(`SPAWN_FAIL exit=${code} stderr=${stderr.slice(0, 500)}`);
        resolve({
          ranked: null,
          model: 'spawn-fail',
          tokensIn: 0,
          tokensOut: 0,
          fallback: 'error',
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout) as RerankResult);
      } catch {
        appendRememberLog(`INVALID_JSON stdout=${stdout.slice(0, 500)}`);
        resolve({
          ranked: null,
          model: 'invalid-json',
          tokensIn: 0,
          tokensOut: 0,
          fallback: 'invalid_json',
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(hardTimer);
      appendRememberLog(`SPAWN_ERROR err=${err.message}`);
      resolve({
        ranked: null,
        model: 'spawn-error',
        tokensIn: 0,
        tokensOut: 0,
        fallback: 'error',
      });
    });
  });
}

/** Injectable subprocess spawn — tests replace this without patching ESM internals. */
export const rememberDeps = {
  spawnRememberSubprocess: spawnRememberSubprocessImpl,
};

export { spawnRememberSubprocessImpl as spawnRememberSubprocess };

function buildFtsFallbackResult(
  opts: TimRememberOptions,
  deduped: Entry[],
  startTime: number,
  rerankResult: RerankResult,
  candidatesMap: Map<string, RememberCandidate>,
  candidatesFts: number,
): TimRememberResult {
  const hits = deduped.slice(0, opts.topK);
  return {
    query: opts.query,
    results: hits.map((hit) => ftsHitToResultItem(hit, candidatesMap.get(hit.id))),
    meta: {
      latency_ms: Date.now() - startTime,
      candidates_fts: candidatesFts,
      candidates_after_rerank: hits.length,
      dropped_hallucinated: 0,
      sub_process_model: rerankResult.model,
      sub_process_tokens_in: rerankResult.tokensIn,
      sub_process_tokens_out: rerankResult.tokensOut,
      fallback_used: rerankResult.fallback,
    },
  };
}

export async function handleTimRemember(
  store: TimStore,
  opts: TimRememberOptions,
): Promise<TimRememberResult> {
  const startTime = Date.now();
  const auditParts: string[] = [];
  const config = loadConfig();
  const hardTimeoutMs = config.remember?.hard_timeout_ms ?? 8000;

  const variants = expandQueryVariants(opts.query);
  auditParts.push(`variants=${variants.length}`);

  const ftsHits = await Promise.all(
    variants.map((query) =>
      store.search({
        query,
        topK: opts.topK * 4,
        searchType: 'fts',
      }),
    ),
  );
  let deduped = dedupeById(ftsHits.flat());
  deduped = filterByProjectScope(store, deduped, opts.projectScope);
  auditParts.push(`fts=${deduped.length}`);

  if (deduped.length === 0) {
    appendRememberLog(`no_fts_hits query="${opts.query.slice(0, 80)}"`);
    return buildEmptyResult(opts, startTime, 'no_fts_hits', 0);
  }

  let batchSummaries: Array<{ id: string; title: string; excerpt: string }> = [];
  if (opts.includeBatchSummaries) {
    const sessionId = resolveActiveSessionId({});
    const summaries = await store.getRecentBatchSummaries({
      limit: 5,
      maxAgeDays: 30,
      sessionId: sessionId ?? undefined,
      root: opts.projectScope,
    });
    batchSummaries = summaries.map((summary) => ({
      id: summary.id,
      title: summary.title.slice(0, 80),
      excerpt: (summary.content || '').slice(0, 300),
    }));
  }

  const topCandidates = deduped.slice(0, 30);
  const candidatesForRerank = await prefetchCandidates(store, topCandidates);
  const candidatesMap = new Map(candidatesForRerank.map((candidate) => [candidate.id, candidate]));

  const rerankInput: RememberQueryInput = {
    query: opts.query,
    candidates: candidatesForRerank,
    batchSummaries,
    topK: opts.topK,
  };

  const rerankStart = Date.now();
  const rerankResult = await rememberDeps.spawnRememberSubprocess(rerankInput, hardTimeoutMs);
  const rerankMs = Date.now() - rerankStart;
  if (rerankMs < 100) {
    auditParts.push('suspiciously_fast=true');
  }

  const needsFtsFallback =
    rerankResult.fallback !== 'none' ||
    !rerankResult.ranked ||
    rerankResult.ranked.length === 0;

  if (needsFtsFallback) {
    const effectiveRerank: RerankResult =
      rerankResult.fallback !== 'none'
        ? rerankResult
        : { ...rerankResult, fallback: 'all_chain_failed', ranked: null };
    appendRememberLog(
      `fallback=${effectiveRerank.fallback} query="${opts.query.slice(0, 80)}" ${auditParts.join(' ')} latency_ms=${Date.now() - startTime}`,
    );
    return buildFtsFallbackResult(
      opts,
      deduped,
      startTime,
      effectiveRerank,
      candidatesMap,
      deduped.length,
    );
  }

  const ranked = rerankResult.ranked!;
  const schemaValid = filterValidRanked(ranked);
  const rankedIds = schemaValid.map((item) => item.node_id);
  const existingIds = await store.entryExistsBatch(rankedIds);
  const verified = schemaValid.filter((item) => existingIds.has(item.node_id));
  const droppedCount = rankedIds.length - verified.length;
  auditParts.push(`dropped_hallucinated=${droppedCount}`);

  const finalResults = verified
    .filter((item) => item.confidence >= opts.minConfidence)
    .slice(0, opts.topK);

  appendRememberLog(
    `query="${opts.query.slice(0, 80)}" ${auditParts.join(' ')} latency_ms=${Date.now() - startTime} model=${rerankResult.model} fallback=${rerankResult.fallback}`,
  );

  return {
    query: opts.query,
    results: finalResults.map((item) => toOutputShape(item, candidatesMap)),
    meta: {
      latency_ms: Date.now() - startTime,
      candidates_fts: deduped.length,
      candidates_after_rerank: verified.length,
      dropped_hallucinated: droppedCount,
      sub_process_model: rerankResult.model,
      sub_process_tokens_in: rerankResult.tokensIn,
      sub_process_tokens_out: rerankResult.tokensOut,
      fallback_used: 'none',
    },
  };
}
