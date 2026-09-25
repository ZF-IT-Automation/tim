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
  type SyncConfig,
  type SyncState,
  type SyncConfigRead,
  type SyncRepairResult,
} from './config.js';
export { loadQueue, saveQueue, enqueue, flushQueue, PUSH_CHUNK, type QueueItem } from './queue.js';
export {
  pushCycle,
  pullCycle,
  runPush,
  runPull,
  buildSyncContext,
  formatSyncFailure,
  encryptSecretPayload,
  decryptSecretPayload,
  isSecretPlaceholderPayload,
  SECRET_PLACEHOLDER_TITLE,
  type SyncCycleContext,
} from './sync.js';
export {
  MissingSecretPassphraseError,
  resolveSecretPassphrase,
} from './credentials.js';
export { autoPush, autoPull, resetSyncCooldowns, _peekCooldown } from './auto-sync.js';
export { startDevServer, resetDevServer } from './dev-server.js';
export { collectSyncAudit, type SyncAuditReport } from './audit.js';
