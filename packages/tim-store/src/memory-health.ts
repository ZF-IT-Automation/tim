import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  MemoryCoverageLatestBatchSummary,
  MemoryCoverageLatestRollup,
  MemoryCoverageSeqRange,
  MemoryCoverageWorkState,
  MemoryHealthReport,
  MemorySummaryCoverageReport,
  MemorySyncTelemetryReport,
  MemorySyncTelemetryState,
} from 'tim-core';
import { getTimDir } from 'tim-core';
import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { getUnackedStaging } from './sync-methods.js';
import { deriveSessionCoverage } from './session-coverage.js';
import { KIND_BATCH, KIND_SESSION, KIND_SUMMARY_ROOT } from './session-tree.js';
import type { SemanticIndexHealthReport } from './vector-index.js';

const ALL_SESSIONS = 1_000_000;
const MAX_RANGE_SAMPLES = 50;

interface SyncFileState {
  lastPush: string | null;
  lastPull: string | null;
}

function readSyncTelemetry(unackedStaging: number): MemorySyncTelemetryReport {
  const syncConfigPath = path.join(getTimDir(), 'sync.json');
  const syncStatePath = path.join(getTimDir(), 'sync-state.json');
  const configured = fs.existsSync(syncConfigPath);
  if (!configured) {
    return {
      telemetryState: 'not_configured',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  let state: SyncFileState | null = null;
  if (fs.existsSync(syncStatePath)) {
    try {
      state = JSON.parse(fs.readFileSync(syncStatePath, 'utf8')) as SyncFileState;
    } catch {
      state = null;
    }
  }

  const telemetryState: MemorySyncTelemetryState = state ? 'available' : 'configured_no_state';
  return {
    telemetryState,
    lastPush: state?.lastPush ?? null,
    lastPull: state?.lastPull ?? null,
    unackedStaging,
  };
}

function compactSeqRanges(
  sessionId: string,
  batchIndex: number,
  seqs: number[],
): MemoryCoverageSeqRange[] {
  if (seqs.length === 0) return [];
  const sorted = [...seqs].sort((a, b) => a - b);
  const ranges: MemoryCoverageSeqRange[] = [];
  let start = sorted[0]!;
  let end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const seq = sorted[i]!;
    if (seq === end + 1) {
      end = seq;
      continue;
    }
    ranges.push({ sessionId, batchIndex, seqFrom: start, seqTo: end });
    start = seq;
    end = seq;
  }
  ranges.push({ sessionId, batchIndex, seqFrom: start, seqTo: end });
  return ranges;
}

function isValidSummaryRange(seqFrom: number, seqTo: number): boolean {
  return Number.isFinite(seqFrom) && Number.isFinite(seqTo) && seqFrom <= seqTo;
}

function parseLatestBatchSummary(entry: Entry): MemoryCoverageLatestBatchSummary {
  const sessionId = typeof entry.metadata.sessionId === 'string'
    ? entry.metadata.sessionId
    : '';
  const batchIndex = Number(entry.metadata.batch_index);
  const seqFrom = Number(entry.metadata.seq_from);
  const seqTo = Number(entry.metadata.seq_to);
  const rangeKnown = isValidSummaryRange(seqFrom, seqTo);
  const summarizedAt = typeof entry.metadata.summarized_at === 'string'
    ? entry.metadata.summarized_at
    : null;
  return {
    sessionId,
    batchIndex: Number.isFinite(batchIndex) ? batchIndex : 0,
    summaryId: entry.id,
    summarizedAt,
    seqFrom: rangeKnown ? seqFrom : null,
    seqTo: rangeKnown ? seqTo : null,
    rangeKnown,
  };
}

function parseLatestRollup(entry: Entry): MemoryCoverageLatestRollup {
  const sessionId = typeof entry.metadata.sessionId === 'string'
    ? entry.metadata.sessionId
    : entry.id;
  const rollup = entry.metadata.summary;
  const hasRollupText = typeof rollup === 'string' && rollup.trim().length > 0;
  return {
    sessionId,
    summaryRootId: entry.id,
    updatedAt: entry.updatedAt || entry.createdAt,
    hasRollupText,
  };
}

function buildGuidance(
  summary: MemorySummaryCoverageReport,
  semantic: SemanticIndexHealthReport,
  sync: MemorySyncTelemetryReport,
): string[] {
  const guidance: string[] = [];

  switch (summary.workState) {
    case 'no_sessions':
      guidance.push('No project sessions observed — exchange coverage is idle.');
      break;
    case 'no_exchanges':
      guidance.push('Sessions exist but no user exchanges logged yet.');
      break;
    case 'fully_covered':
      guidance.push('All observed exchanges are covered by batch summary ranges.');
      break;
    case 'pending':
      guidance.push(
        `${summary.pendingExchangeCount} exchange(s) pending summarization across ` +
        `${summary.sessionsWithPending} session(s). Inspect idle sweep or showUnsummarized.`,
      );
      break;
    case 'unknown':
      guidance.push('Summary coverage telemetry incomplete — do not infer health from absence.');
      break;
  }

  if (summary.latestBatchSummary && !summary.latestBatchSummary.rangeKnown) {
    guidance.push(
      'Latest batch summary has invalid or missing seq range — associated exchanges stay pending.',
    );
  }

  switch (semantic.providerState) {
    case 'disabled':
      guidance.push('Semantic search disabled (TIM_EMBEDDING_DISABLED=1). Vector mode unavailable.');
      break;
    case 'unavailable':
      guidance.push('Configured embedding model is unsupported — fix TIM_EMBEDDING_MODEL.');
      break;
    case 'unknown':
      guidance.push('Embedding provider not initialized — health reads never load models.');
      break;
    case 'enabled': {
      const backlog = semantic.unembeddedCount + semantic.staleVectorCount + semantic.wrongModelCount;
      if (backlog > 0) {
        guidance.push(
          `${backlog} eligible entry vector(s) need (re)indexing ` +
          `(unembedded=${semantic.unembeddedCount}, stale=${semantic.staleVectorCount}, ` +
          `wrongModel=${semantic.wrongModelCount}).`,
        );
      } else if (semantic.vectorCount === 0) {
        guidance.push('Embedding enabled but no vectors indexed yet — backlog may be zero work.');
      }
      break;
    }
  }

  switch (sync.telemetryState) {
    case 'not_configured':
      guidance.push('Sync not configured — only local device state is reported.');
      break;
    case 'configured_no_state':
      guidance.push('Sync configured but no sync-state.json telemetry yet.');
      break;
    case 'available':
      if (sync.unackedStaging > 0) {
        guidance.push(`${sync.unackedStaging} staging row(s) await sync push.`);
      }
      break;
  }

  return guidance;
}

async function computeSummaryCoverage(store: TimStore): Promise<MemorySummaryCoverageReport> {
  const sessions = await store.getByMetadataKind(KIND_SESSION, ALL_SESSIONS);
  if (sessions.length === 0) {
    return {
      workState: 'no_sessions',
      observedExchangeCount: 0,
      coveredExchangeCount: 0,
      pendingExchangeCount: 0,
      sessionsWithPending: 0,
      pendingRanges: [],
      coveredRanges: [],
      latestBatchSummary: null,
      latestRollup: null,
    };
  }

  let observedExchangeCount = 0;
  let pendingExchangeCount = 0;
  let sessionsWithPending = 0;
  const pendingRanges: MemoryCoverageSeqRange[] = [];
  const coveredRanges: MemoryCoverageSeqRange[] = [];
  let workState: MemoryCoverageWorkState = 'fully_covered';

  for (const session of sessions) {
    const coverage = await deriveSessionCoverage(store, session.id);
    observedExchangeCount += coverage.exchangeCount;
    pendingExchangeCount += coverage.uncovered.length;
    if (coverage.hasPendingSummarization) sessionsWithPending++;

    const byBatch = new Map<number, number[]>();
    for (const u of coverage.uncovered) {
      const list = byBatch.get(u.batchIndex) ?? [];
      list.push(u.seq);
      byBatch.set(u.batchIndex, list);
    }
    for (const [batchIndex, seqs] of byBatch) {
      for (const range of compactSeqRanges(session.id, batchIndex, seqs)) {
        if (pendingRanges.length < MAX_RANGE_SAMPLES) pendingRanges.push(range);
      }
    }

    for (const covered of coverage.coveredRanges) {
      const seqFrom = covered.seqFrom;
      const seqTo = covered.seqTo;
      if (!isValidSummaryRange(seqFrom, seqTo)) {
        workState = 'unknown';
        continue;
      }
      if (coveredRanges.length < MAX_RANGE_SAMPLES) {
        coveredRanges.push({
          sessionId: session.id,
          batchIndex: covered.batchIndex,
          seqFrom,
          seqTo,
        });
      }
    }
  }

  if (observedExchangeCount === 0) {
    workState = 'no_exchanges';
  } else if (pendingExchangeCount > 0) {
    workState = 'pending';
  } else if (workState !== 'unknown') {
    workState = 'fully_covered';
  }

  const recentBatches = await store.getRecentBatchSummaries({ limit: 1, maxAgeDays: 36500 });
  const latestBatchRow = recentBatches[0];

  const rollupRoots = await store.getByMetadataKind(KIND_SUMMARY_ROOT, 200);
  const latestRollupRow = rollupRoots
    .filter(e => {
      const rollup = e.metadata.summary;
      return typeof rollup === 'string' && rollup.trim().length > 0;
    })
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0];

  const coveredExchangeCount = Math.max(0, observedExchangeCount - pendingExchangeCount);

  return {
    workState,
    observedExchangeCount,
    coveredExchangeCount,
    pendingExchangeCount,
    sessionsWithPending,
    pendingRanges,
    coveredRanges,
    latestBatchSummary: latestBatchRow ? parseLatestBatchSummary(latestBatchRow) : null,
    latestRollup: latestRollupRow ? parseLatestRollup(latestRollupRow) : null,
  };
}

/** Shared read-only memory diagnostics for health/doctor (#37). */
export async function computeMemoryHealth(store: TimStore): Promise<MemoryHealthReport> {
  const unackedStaging = getUnackedStaging(store.getDb()).length;
  const sync = readSyncTelemetry(unackedStaging);
  const summaryCoverage = await computeSummaryCoverage(store);
  const semanticIndex = store.getSemanticIndexHealth();
  const guidance = buildGuidance(summaryCoverage, semanticIndex, sync);

  return {
    summaryCoverage,
    semanticIndex,
    sync,
    guidance,
  };
}

/** Human-readable memory lines for CLI/MCP doctor output. */
export function formatMemoryHealthLines(memory: MemoryHealthReport): string[] {
  const { summaryCoverage: s, semanticIndex: idx, sync } = memory;
  const lines = [
    `Memory exchanges: ${s.observedExchangeCount} observed, ${s.coveredExchangeCount} covered, ` +
      `${s.pendingExchangeCount} pending (${s.workState})`,
    `Semantic index: provider=${idx.providerState}, vectors=${idx.vectorCount}, ` +
      `unembedded=${idx.unembeddedCount}, stale=${idx.staleVectorCount}, ` +
      `wrongModel=${idx.wrongModelCount}`,
    `Sync telemetry: ${sync.telemetryState}, unacked=${sync.unackedStaging}`,
  ];
  if (s.latestBatchSummary) {
    const b = s.latestBatchSummary;
    lines.push(
      `Latest batch summary: session=${b.sessionId} batch=${b.batchIndex} ` +
        `rangeKnown=${b.rangeKnown} at=${b.summarizedAt ?? 'unknown'}`,
    );
  }
  if (s.latestRollup) {
    const r = s.latestRollup;
    lines.push(`Latest session rollup: session=${r.sessionId} at=${r.updatedAt}`);
  }
  for (const g of memory.guidance) {
    lines.push(`  → ${g}`);
  }
  return lines;
}
