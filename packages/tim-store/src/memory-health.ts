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
import { getTimDir, isTimezoneQualifiedIso } from 'tim-core';
import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { deriveSessionCoverage } from './session-coverage.js';
import { KIND_BATCH, KIND_SESSION, KIND_SUMMARY_ROOT } from './session-tree.js';
import type { SemanticIndexHealthReport } from './vector-index.js';

const ALL_SESSIONS = 1_000_000;
const MAX_RANGE_SAMPLES = 50;

interface SyncConfigShape {
  fileId?: unknown;
}

interface SyncFileState {
  fileId?: unknown;
  lastPush?: unknown;
  lastPull?: unknown;
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  return isTimezoneQualifiedIso(value);
}

function parseSyncTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return isValidIsoTimestamp(value) ? value : null;
}

function readSyncTelemetry(unackedStaging: number, telemetryDir: string): MemorySyncTelemetryReport {
  const syncConfigPath = path.join(telemetryDir, 'sync.json');
  const syncStatePath = path.join(telemetryDir, 'sync-state.json');
  if (!fs.existsSync(syncConfigPath)) {
    return {
      telemetryState: 'not_configured',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  let config: SyncConfigShape | null = null;
  try {
    config = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8')) as SyncConfigShape;
  } catch {
    return {
      telemetryState: 'malformed',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  if (!config || typeof config !== 'object') {
    return {
      telemetryState: 'malformed',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  const configuredFileId = typeof config.fileId === 'string' ? config.fileId : null;
  if (!configuredFileId) {
    return {
      telemetryState: 'malformed',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  if (!fs.existsSync(syncStatePath)) {
    return {
      telemetryState: 'configured_no_state',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  let state: SyncFileState | null = null;
  try {
    state = JSON.parse(fs.readFileSync(syncStatePath, 'utf8')) as SyncFileState;
  } catch {
    return {
      telemetryState: 'malformed',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  if (!state || typeof state !== 'object') {
    return {
      telemetryState: 'malformed',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  const stateFileId = typeof state.fileId === 'string' ? state.fileId : null;
  if (!stateFileId || stateFileId !== configuredFileId) {
    return {
      telemetryState: 'mismatched_file',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  const lastPush = parseSyncTimestamp(state.lastPush);
  const lastPull = parseSyncTimestamp(state.lastPull);
  const hasInvalidTimestamp =
    (state.lastPush !== null && state.lastPush !== undefined && lastPush === null)
    || (state.lastPull !== null && state.lastPull !== undefined && lastPull === null);
  if (hasInvalidTimestamp) {
    return {
      telemetryState: 'malformed',
      lastPush: null,
      lastPull: null,
      unackedStaging,
    };
  }

  const telemetryState: MemorySyncTelemetryState = 'available';
  return {
    telemetryState,
    lastPush,
    lastPull,
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

function isSuccessfulBatchSummary(entry: Entry): boolean {
  if (entry.metadata.kind !== KIND_BATCH) return false;
  return isSuccessfulSummaryText(entry.content);
}

function isSuccessfulSummaryText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
    && !value.includes('TIM_SUMMARIZER_FALLBACK_NEEDED')
    && !value.includes('[ALL SUMMARIZER CLIs FAILED');
}

function batchSummaryTimestamp(entry: Entry): string {
  const summarizedAt = entry.metadata.summarized_at;
  if (typeof summarizedAt === 'string' && summarizedAt.length > 0) return summarizedAt;
  return entry.updatedAt || entry.createdAt;
}

function resolveOwningSessionId(store: TimStore, entry: Entry): string | null {
  if (typeof entry.metadata.sessionId === 'string' && entry.metadata.sessionId.trim()) {
    return entry.metadata.sessionId;
  }
  let parentId = entry.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = store.readSync(parentId);
    if (!parent) break;
    if (parent.metadata.kind === KIND_SESSION) {
      const sid = typeof parent.metadata.sessionId === 'string'
        ? parent.metadata.sessionId
        : parent.id;
      return sid;
    }
    parentId = parent.parentId;
  }
  return null;
}

async function findLatestSuccessfulBatchSummary(store: TimStore): Promise<Entry | null> {
  const rows = store.getDb().prepare(`
    SELECT * FROM entries
    WHERE json_extract(metadata, '$.kind') = ?
      AND irrelevant = 0
      AND tombstoned_at IS NULL
      AND trim(COALESCE(content, '')) != ''
  `).all(KIND_BATCH) as Array<{
    id: string;
    parent_id: string | null;
    content: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  }>;

  const candidates: Entry[] = [];
  for (const row of rows) {
    const entry = await store.read(row.id, { showIrrelevant: true, includeChildren: false });
    if (entry && isSuccessfulBatchSummary(entry)) candidates.push(entry);
  }

  candidates.sort((a, b) => batchSummaryTimestamp(b).localeCompare(batchSummaryTimestamp(a)));
  return candidates[0] ?? null;
}

async function findLatestSuccessfulRollup(store: TimStore): Promise<Entry | null> {
  const rows = store.getDb().prepare(`
    SELECT * FROM entries
    WHERE json_extract(metadata, '$.kind') = ?
      AND irrelevant = 0
      AND tombstoned_at IS NULL
      AND trim(COALESCE(json_extract(metadata, '$.summary'), '')) != ''
  `).all(KIND_SUMMARY_ROOT) as Array<{ id: string }>;

  const candidates: Entry[] = [];
  for (const row of rows) {
    const entry = await store.read(row.id, { showIrrelevant: true, includeChildren: false });
    if (!entry) continue;
    const rollup = entry.metadata.summary;
    if (isSuccessfulSummaryText(rollup)) candidates.push(entry);
  }

  candidates.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return candidates[0] ?? null;
}

function parseLatestBatchSummary(
  store: TimStore,
  entry: Entry,
): MemoryCoverageLatestBatchSummary | null {
  if (!isSuccessfulBatchSummary(entry)) return null;
  const sessionId = resolveOwningSessionId(store, entry) ?? '';
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

function parseLatestRollup(store: TimStore, entry: Entry): MemoryCoverageLatestRollup | null {
  const rollup = entry.metadata.summary;
  const hasRollupText = typeof rollup === 'string' && rollup.trim().length > 0;
  if (!hasRollupText) return null;
  return {
    sessionId: resolveOwningSessionId(store, entry),
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

  if (summary.unknownSequenceExchangeCount > 0) {
    guidance.push(
      `${summary.unknownSequenceExchangeCount} exchange(s) have missing or invalid seq metadata — coverage unknown for those rows.`,
    );
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
      const backlog = semantic.unembeddedCount;
      if (backlog > 0) {
        const parts: string[] = [`${backlog} eligible entry vector(s) need (re)indexing`];
        const breakdown: string[] = [];
        if (semantic.staleVectorCount > 0) breakdown.push(`stale=${semantic.staleVectorCount}`);
        if (semantic.wrongModelCount > 0) breakdown.push(`wrongModel=${semantic.wrongModelCount}`);
        if (breakdown.length > 0) parts.push(`(${breakdown.join(', ')})`);
        guidance.push(parts.join(' '));
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
    case 'malformed':
      guidance.push('Sync telemetry unreadable or invalid — treat push/pull history as unknown.');
      break;
    case 'mismatched_file':
      guidance.push('Sync state fileId does not match sync.json — local push/pull timestamps ignored.');
      break;
    case 'available':
      if (sync.unackedStaging > 0) {
        guidance.push(`${sync.unackedStaging} staging row(s) await sync push.`);
      }
      if (sync.lastPush || sync.lastPull) {
        guidance.push('Sync timestamps are historical local evidence only — not current server reachability.');
      }
      break;
  }

  return guidance;
}

function sampleRanges(
  ranges: MemoryCoverageSeqRange[],
): { samples: MemoryCoverageSeqRange[]; total: number; truncated: boolean } {
  return {
    samples: ranges.slice(0, MAX_RANGE_SAMPLES),
    total: ranges.length,
    truncated: ranges.length > MAX_RANGE_SAMPLES,
  };
}

async function computeSummaryCoverage(store: TimStore): Promise<MemorySummaryCoverageReport> {
  const sessions = await store.getByMetadataKind(KIND_SESSION, ALL_SESSIONS);
  if (sessions.length === 0) {
    return {
      workState: 'no_sessions',
      observedExchangeCount: 0,
      coveredExchangeCount: 0,
      pendingExchangeCount: 0,
      unknownSequenceExchangeCount: 0,
      sessionsWithPending: 0,
      pendingRanges: [],
      coveredRanges: [],
      pendingRangeCount: 0,
      coveredRangeCount: 0,
      pendingRangesTruncated: false,
      coveredRangesTruncated: false,
      latestBatchSummary: null,
      latestRollup: null,
    };
  }

  let observedExchangeCount = 0;
  let pendingExchangeCount = 0;
  let unknownSequenceExchangeCount = 0;
  let sessionsWithPending = 0;
  const allPendingRanges: MemoryCoverageSeqRange[] = [];
  const allCoveredRanges: MemoryCoverageSeqRange[] = [];
  let workState: MemoryCoverageWorkState = 'fully_covered';

  for (const session of sessions) {
    const coverage = await deriveSessionCoverage(store, session.id);
    observedExchangeCount += coverage.exchangeCount;
    pendingExchangeCount += coverage.uncovered.length;
    unknownSequenceExchangeCount += coverage.unknownSequenceExchangeCount;
    if (coverage.hasPendingSummarization) sessionsWithPending++;

    const byBatch = new Map<number, number[]>();
    for (const u of coverage.uncovered) {
      const list = byBatch.get(u.batchIndex) ?? [];
      list.push(u.seq);
      byBatch.set(u.batchIndex, list);
    }
    for (const [batchIndex, seqs] of byBatch) {
      for (const range of compactSeqRanges(session.id, batchIndex, seqs)) {
        allPendingRanges.push(range);
      }
    }

    for (const covered of coverage.coveredRanges) {
      const seqFrom = covered.seqFrom;
      const seqTo = covered.seqTo;
      if (!isValidSummaryRange(seqFrom, seqTo)) {
        workState = 'unknown';
        continue;
      }
      allCoveredRanges.push({
        sessionId: session.id,
        batchIndex: covered.batchIndex,
        seqFrom,
        seqTo,
      });
    }
  }

  if (unknownSequenceExchangeCount > 0) {
    workState = 'unknown';
  } else if (observedExchangeCount === 0) {
    workState = 'no_exchanges';
  } else if (pendingExchangeCount > 0) {
    workState = 'pending';
  } else if (workState !== 'unknown') {
    workState = 'fully_covered';
  }

  const latestBatchRow = await findLatestSuccessfulBatchSummary(store);
  const latestRollupRow = await findLatestSuccessfulRollup(store);
  const pendingSample = sampleRanges(allPendingRanges);
  const coveredSample = sampleRanges(allCoveredRanges);
  const coveredExchangeCount = Math.max(0, observedExchangeCount - pendingExchangeCount);

  return {
    workState,
    observedExchangeCount,
    coveredExchangeCount,
    pendingExchangeCount,
    unknownSequenceExchangeCount,
    sessionsWithPending,
    pendingRanges: pendingSample.samples,
    coveredRanges: coveredSample.samples,
    pendingRangeCount: pendingSample.total,
    coveredRangeCount: coveredSample.total,
    pendingRangesTruncated: pendingSample.truncated,
    coveredRangesTruncated: coveredSample.truncated,
    latestBatchSummary: latestBatchRow ? parseLatestBatchSummary(store, latestBatchRow) : null,
    latestRollup: latestRollupRow ? parseLatestRollup(store, latestRollupRow) : null,
  };
}

/** Shared read-only memory diagnostics for health/doctor (#37). */
export async function computeMemoryHealth(
  store: TimStore,
  options: { telemetryDir?: string } = {},
): Promise<MemoryHealthReport> {
  const unackedStaging = (store.getDb().prepare('SELECT COUNT(*) AS count FROM staging WHERE acked = 0')
    .get() as { count: number }).count;
  const sync = readSyncTelemetry(unackedStaging, options.telemetryDir ?? getTimDir());
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
  const pendingRangeNote = s.pendingRangesTruncated
    ? `, showing ${s.pendingRanges.length}/${s.pendingRangeCount}`
    : '';
  const coveredRangeNote = s.coveredRangesTruncated
    ? `, showing ${s.coveredRanges.length}/${s.coveredRangeCount}`
    : '';
  const lines = [
    `Memory exchanges: ${s.observedExchangeCount} observed, ${s.coveredExchangeCount} covered, ` +
      `${s.pendingExchangeCount} pending (${s.workState})`,
    `Memory ranges: pending=${s.pendingRangeCount}${pendingRangeNote}, ` +
      `covered=${s.coveredRangeCount}${coveredRangeNote}`,
    `Semantic index: provider=${idx.providerState}, vectors=${idx.vectorCount}, ` +
      `needsIndexing=${idx.unembeddedCount}` +
      (idx.staleVectorCount > 0 || idx.wrongModelCount > 0
        ? ` (stale=${idx.staleVectorCount}, wrongModel=${idx.wrongModelCount})`
        : ''),
    `Sync telemetry: ${sync.telemetryState}, unacked=${sync.unackedStaging}` +
      (sync.lastPush ? `, lastPush=${sync.lastPush}` : '') +
      (sync.lastPull ? `, lastPull=${sync.lastPull}` : ''),
  ];
  if (s.latestBatchSummary) {
    const b = s.latestBatchSummary;
    lines.push(
      `Latest batch summary: session=${b.sessionId || 'unknown'} batch=${b.batchIndex} ` +
        `rangeKnown=${b.rangeKnown} at=${b.summarizedAt ?? 'unknown'}`,
    );
  }
  if (s.latestRollup) {
    const r = s.latestRollup;
    lines.push(
      `Latest session rollup: session=${r.sessionId ?? 'unknown'} at=${r.updatedAt}`,
    );
  }
  for (const g of memory.guidance) {
    lines.push(`  → ${g}`);
  }
  return lines;
}
