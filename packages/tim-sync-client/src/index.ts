export { TimSyncClient, SyncApiError } from './client.js';
export type { PushBlob, PushRequest, PushResponse, PullBlob, PullResponse, TimFile } from './client.js';
export { deriveKey, encrypt, decrypt, generateSalt } from './crypto.js';
export {
  stagingToEnvelope,
  envelopeToStaging,
  stagingKey,
  parseStagingKey,
  edgeCompositeKey,
  type TimEnvelope,
} from './envelope.js';
export {
  loadConfig,
  saveConfig,
  clearConfig,
  clearSyncState,
  clearSyncConnection,
  loadSyncState,
  saveSyncState,
  getDeviceId,
  defaultFileId,
  getSyncConfigPath,
  getSyncStatePath,
  getQueuePath,
  readSyncConfig,
  readSyncStateFile,
  classifySyncStateFile,
  canonicalDbIdentity,
  bindingFor,
  freshBoundSyncState,
  loadBoundSyncState,
  repairSyncState,
  describeSyncConfigStatus,
  SyncStateRejectedError,
  SyncStateConflictError,
  type SyncConfig,
  type SyncState,
  type SyncConfigRead,
  type SyncRepairResult,
} from './config.js';
export {
  loadQueue,
  saveQueue,
  enqueue,
  flushQueue,
  planQueueBatches,
  queuedRevisions,
  serializedPushBytes,
  PUSH_CHUNK,
  PUSH_BATCH_MAX_BYTES,
  type QueueItem,
} from './queue.js';
export {
  pushCycle,
  pullCycle,
  runPush,
  runPull,
  buildSyncContext,
  formatSyncFailure,
  syncCycleExitCode,
  thrownSyncExitCode,
  type PushCycleResult,
  type SyncCycleOptions,
  encryptSecretPayload,
  decryptSecretPayload,
  unlockPersistedSecretEntries,
  isLockedSecretPayload,
  isSecretPlaceholderPayload,
  SECRET_PLACEHOLDER_TITLE,
  type SecretUnlockResult,
  type SyncCycleContext,
} from './sync.js';
export {
  MissingSecretPassphraseError,
  SecretPayloadAuthenticationError,
  SecretPayloadMalformedError,
  SecretWrongKeyError,
  SecretUndecryptableError,
  resolveSecretPassphrase,
} from './credentials.js';
export { autoPush, autoPull, resetSyncCooldowns, _peekCooldown } from './auto-sync.js';
export {
  OWNER_DEFAULT_DEADLINE_MS,
  OWNER_DEFAULT_INTERVAL_MS,
  runSyncOwner,
  type OwnerCycleResult,
  type SyncOwnerOptions,
} from './owner.js';
export { PERMANENT_SYNC_CODES, parseRetryAfter, type SyncCallOptions } from './client.js';
export {
  SYNC_MUTATION_LOCK,
  SyncLockBusyError,
  insideSyncMutation,
  processStartTime,
  syncDbIdentity,
  syncLockPath,
  syncOwnerActive,
  syncOwnerLockName,
  tryAcquireSyncLock,
  withSyncMutationAsync,
  withSyncMutationSync,
  type SyncLockHandle,
} from './lock.js';
export { startDevServer, resetDevServer } from './dev-server.js';
export { collectSyncAudit, type SyncAuditReport } from './audit.js';
