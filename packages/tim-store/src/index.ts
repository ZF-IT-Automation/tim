// TIM Store — package exports

export {
  TimStore,
  type TimStoreOptions,
  type CreateProjectOptions,
  type LoadProjectOptions,
  type LoadProjectResult,
  type TaskRecord,
  type GetTasksOptions,
} from './store.js';
export type { ResolveProjectResult } from 'tim-core';
export {
  formatProjectOutput,
  type ProjectSchema,
  type ProjectSchemaSection,
} from './project-output.js';
export {
  cropDisplayName,
  projectDisplayNameFromEntry,
  resolveProjectDisplayName,
  resolveProjectBindingLabel,
} from './project-display.js';
export { runMigrations, getCurrentVersion, MIGRATIONS } from './schema.js';
export {
  SessionManager,
  type Exchange,
  type ExchangeRole,
  type SessionStartParams,
  type ProjectSessionParams,
  type Summarizer,
  type UnsummarizedBatch,
  type UnsummarizedExchange,
  type UntaggedBatch,
  type BatchFullInfo,
  type OnBatchFullHandler,
} from './session.js';
export {
  deriveCounters,
  findChildByKind,
  getCurrentBatch,
  ensureInboxProject,
  type DerivedCounters,
  type CurrentBatch,
  SESSIONS_SECTION_TITLE,
  SUMMARY_NODE_TITLE,
  EXCHANGES_NODE_TITLE,
  KIND_SESSIONS_ROOT,
  KIND_SESSION,
  KIND_SUMMARY_ROOT,
  KIND_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGE,
  SESSION_SUMMARY_TAG,
  DEFAULT_BATCH_SIZE,
  SESSION_ROLLUP_THRESHOLD,
  MARKER_FILENAME,
  MARKER_LOCK,
  INBOX_PROJECT_LABEL,
} from './session-tree.js';
export {
  CommitManager,
  type RecordCommitParams,
} from './commit.js';
export {
  COMMITS_SECTION_TITLE,
  COMMITS_SECTION_ORDER,
  KIND_COMMITS_ROOT,
  KIND_COMMIT,
  COMMIT_TAG,
} from './commit-tree.js';
export { CurateManager, type UpdateManyFlags } from './curate.js';
export { ErrorLogger, type ErrorLogEntry, type ErrorStats } from './error-log.js';
export { formatEntryId, sessionShortFromMetadata } from './entry-id.js';
export {
  ackStaging,
  applyRemoteEntry,
  applyRemoteEdge,
  getUnackedStaging,
  recordFromPayload,
  type StagingRow,
} from './sync-methods.js';
export {
  coerceMetadataBooleans,
  isTaskMarker,
  normalizeTaskValue,
  metadataNeedsCoercion,
  parseAndCoerceMetadata,
  BOOLEAN_METADATA_KEYS,
} from './metadata-coerce.js';
