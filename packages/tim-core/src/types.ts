// packages/tim-core/src/types.ts
// Built-in 14 metadata types for TIM Schema v3 (Tags → Metadata refactor)

/** 14 built-in metadata.type values (Schema v3 Phase 1). */
export const BUILTIN_METADATA_TYPES = [
  'standard',
  'project',
  'task',
  'error',
  'decision',
  'learning',
  'idea',
  'log',
  'commit',
  'summary',
  'session',
  'batch_summary',
  'exchange',
  'event',
] as const;

export type BuiltinMetadataType = (typeof BUILTIN_METADATA_TYPES)[number];

/** Phase 0 legacy values — still valid in DB, not part of the 14 built-ins. */
export const LEGACY_METADATA_TYPES = ['rule', 'human'] as const;
export type LegacyMetadataType = (typeof LEGACY_METADATA_TYPES)[number];

export type MetadataType = BuiltinMetadataType | LegacyMetadataType;

/** @deprecated Use BUILTIN_METADATA_TYPES — kept for callers expecting BUILTIN_TYPES */
export const BUILTIN_TYPES = BUILTIN_METADATA_TYPES;
export type BuiltinType = BuiltinMetadataType;

export const METADATA_TYPES = BUILTIN_METADATA_TYPES;
export const ALL_METADATA_TYPES = [
  ...BUILTIN_METADATA_TYPES,
  ...LEGACY_METADATA_TYPES,
] as const;

export type TaskStatusValue =
  | 'todo'
  | 'in_progress'
  | 'changes_pending'
  | 'pushed'
  | 'reviewed'
  | 'done'
  | 'cancelled';

export interface TaskStatusEvent {
  status: TaskStatusValue;
  at: string; // ISO 8601
  by?: string;
  note?: string;
}

/** Nested task sub-section (Schema v3 Phase 2a). */
export interface TaskMetadata {
  /** Cache of last history entry status */
  status?: TaskStatusValue;
  /** Append-only status log */
  history?: TaskStatusEvent[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  due_date?: string;
  completion_evidence?: string | null;
  subtype?: 'coding';
  commits?: string[];
  /** Set once: git worktree vs not. Not "git installed". */
  vcs?: 'git' | 'none';
}

/** Stub for Phase 2b */
export interface RuleMetadata {
  trigger?: string;
  action?: string;
}

/** Nested bug sub-section (Schema v3 Phase 2c). */
export interface BugMetadata {
  severity?: 'P0' | 'P1' | 'P2' | 'P3';
  status?: 'open' | 'in_progress' | 'fixed' | 'wontfix';
}

/** Nested idea sub-section — lifecycle until promote-to-task. */
export interface IdeaMetadata {
  status?: 'new' | 'planned' | 'parked' | 'rejected';
}

/** Entry metadata — `type` is the Schema v3 semantic classifier. */
export interface EntryMetadata {
  type?: MetadataType;
  kind?: string;
  label?: string;
  /** When true, entry is secret (materialized on descendants). */
  secret?: boolean;
  [key: string]: unknown;
}

export function isBuiltinMetadataType(value: unknown): value is BuiltinMetadataType {
  return typeof value === 'string' && (BUILTIN_METADATA_TYPES as readonly string[]).includes(value);
}

export function isBuiltinType(value: unknown): value is BuiltinMetadataType {
  return isBuiltinMetadataType(value);
}

export function isMetadataType(value: unknown): value is MetadataType {
  return typeof value === 'string' && (ALL_METADATA_TYPES as readonly string[]).includes(value);
}

/** Normalize legacy #rule / #human tags (Phase 0). Other types use section migration. */
export function normalizeLegacyTypeTag(tag: string | null | undefined): LegacyMetadataType | null {
  if (typeof tag !== 'string') return null;
  const cleaned = tag.trim().replace(/^#/, '').toLowerCase();
  if (cleaned === 'rule' || cleaned === 'human') return cleaned;
  return null;
}

// Status/priority tags — DEPRECATED. metadata.task.status is source-of-truth.
export const DEPRECATED_STATUS_TAGS = new Set([
  '#todo', '#done', '#in_progress', '#cancelled',
  'todo', 'done', 'in_progress', 'cancelled',
]);
export const DEPRECATED_PRIORITY_TAGS = new Set([
  '#priority-critical', '#priority-high', '#priority-medium', '#priority-low',
  'priority-critical', 'priority-high', 'priority-medium', 'priority-low',
]);
// Structural tags the session tree used to stamp on every node it wrote. The write sites
// are gone, so nothing emits them automatically any more.
//
// Deliberately NOT part of DEPRECATED_TAGS: these words are subject matter, not just
// plumbing. In a project about sessions, checkpoints and exchanges, a summary of the work
// on checkpoint reaping *should* be able to carry #checkpoint — banning the word would
// cost the tag vocabulary four of the terms the project is most about. The structural
// meaning lives in metadata.kind and never needed a tag.
//
// This set exists for one job: the one-time cleanup of the rows the old write sites left
// behind (`tim migrate retire-deprecated-tags`). Run that cleanup before using any of
// these as a content tag, or the sweep will take the new tag with it.
export const RETIRED_STRUCTURAL_TAGS = new Set([
  '#exchange', 'exchange',
  '#session', 'session',
  '#exchanges', 'exchanges',
  '#sessions', 'sessions',
  '#checkpoint', 'checkpoint',
]);
export const DEPRECATED_TAGS = new Set([
  ...DEPRECATED_STATUS_TAGS,
  ...DEPRECATED_PRIORITY_TAGS,
]);

export function isDeprecatedTag(tag: string): boolean {
  return DEPRECATED_TAGS.has(tag.toLowerCase());
}

export type HealthSeverity = 'OK' | 'WARN' | 'BLOCKER';

export interface MemoryCoverageSeqRange {
  sessionId: string;
  batchIndex: number;
  seqFrom: number;
  seqTo: number;
}

export interface MemoryCoverageLatestBatchSummary {
  sessionId: string;
  batchIndex: number;
  summaryId: string;
  summarizedAt: string | null;
  seqFrom: number | null;
  seqTo: number | null;
  /** False when legacy seq_from/seq_to are missing, nonnumeric or reversed. */
  rangeKnown: boolean;
}

export interface MemoryCoverageLatestRollup {
  /** Owning session id when resolvable; null when only the summary root is known. */
  sessionId: string | null;
  summaryRootId: string;
  updatedAt: string;
  hasRollupText: boolean;
}

export type MemoryCoverageWorkState =
  | 'no_sessions'
  | 'no_exchanges'
  | 'fully_covered'
  | 'pending'
  | 'unknown';

export interface MemorySummaryCoverageReport {
  workState: MemoryCoverageWorkState;
  observedExchangeCount: number;
  coveredExchangeCount: number;
  pendingExchangeCount: number;
  /** User exchanges with missing or invalid positive integer seq metadata. */
  unknownSequenceExchangeCount: number;
  sessionsWithPending: number;
  /** Sessions marked summary_skipped. Their exchanges are not pending. */
  skippedSessionCount: number;
  pendingRanges: MemoryCoverageSeqRange[];
  coveredRanges: MemoryCoverageSeqRange[];
  pendingRangeCount: number;
  coveredRangeCount: number;
  pendingRangesTruncated: boolean;
  coveredRangesTruncated: boolean;
  latestBatchSummary: MemoryCoverageLatestBatchSummary | null;
  latestRollup: MemoryCoverageLatestRollup | null;
}

export type MemorySyncTelemetryState =
  | 'not_configured'
  | 'disconnected'
  | 'invalid_config'
  | 'invalid_json'
  | 'invalid_timestamp'
  | 'configured_no_state'
  | 'available'
  | 'mismatched_file'
  | 'mismatched_db'
  | 'mismatched_server'
  | 'mismatched_tenant'
  | 'mismatched_protocol'
  | 'unbound';

export interface MemorySyncTelemetryReport {
  telemetryState: MemorySyncTelemetryState;
  /** Last successful push. Null unless telemetryState is `available`. */
  lastPush: string | null;
  /** Last successful pull. Null unless telemetryState is `available`. */
  lastPull: string | null;
  lastPushAttempt: string | null;
  lastPullAttempt: string | null;
  lastPushError: string | null;
  lastPullError: string | null;
  /** True only when state is bound to this database, server, tenant, file, and protocol generation. */
  cursorUsable: boolean;
  unackedStaging: number;
}

export interface MemoryHealthReport {
  summaryCoverage: MemorySummaryCoverageReport;
  sync: MemorySyncTelemetryReport;
  guidance: string[];
}

export interface HealthReport {
  status: HealthSeverity;
  blockers: string[];
  warnings: string[];
  brokenLinks: number;
  orphanEntries: number;
  ftsIntegrity: boolean;
  totalEntries: number;
  totalEdges: number;
  staleEntries: number;
  issues: string[];
  /** Additive memory coverage and sync telemetry (#37). */
  memory?: MemoryHealthReport;
}

export function stripDeprecatedTags(tags: string[]): { clean: string[]; removed: string[] } {
  const clean: string[] = [];
  const removed: string[] = [];
  for (const tag of tags) {
    if (isDeprecatedTag(tag)) {
      removed.push(tag);
    } else {
      clean.push(tag);
    }
  }
  return { clean, removed };
}
