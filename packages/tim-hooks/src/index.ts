export {
  runHookScript,
  runHooks,
  runConfiguredHooks,
  embedUnembeddedEntries,
  type HookEnv,
  type HookRunResult,
  type RunHooksOptions,
} from './hooks.js';

export {
  runCheckpoint,
  runSessionStart,
  runSessionEnd,
  loadProjectContext,
  getActiveProjectLabel,
  type SessionEndOptions,
  type SessionStartResult,
} from './checkpoint.js';

export { getDeltaBriefing, type DeltaBriefingOptions } from './delta.js';

export {
  getCheckpointEveryN,
  getBriefingMaxTokens,
  shouldAutoCheckpoint,
  checkpointCadenceReminder,
  DEFAULT_CHECKPOINT_EVERY_N,
  DEFAULT_BRIEFING_MAX_TOKENS,
} from './cadence.js';

export { afterExchangeLogged, type CadenceResult } from './cadence-runner.js';

export {
  runPromptSubmit,
  type PromptSubmitParams,
  type PromptSubmitResult,
} from './prompt-submit.js';

export {
  runClaudeStop,
  readLastExchange,
  MAX_TRANSCRIPT_BYTES,
  MAX_EXCHANGE_CHARS,
  type ClaudeStopPayload,
  type ClaudeStopResult,
} from './claude-stop.js';

export {
  readMarker,
  writeMarker,
  writeMarkerAtomic,
  rotateMarkerSession,
  detectProject,
  discoverMarker,
  findMarker,
  findMarkerOptionsFromEnv,
  DEFAULT_MARKER_DISCOVERY_POLICY,
  CWD_ONLY_MARKER_DISCOVERY_POLICY,
  buildLoadDirective,
  buildSessionDirective,
  reconcileMarker,
  syncNearestProjectMarker,
  validateMarkerAgainstStore,
  validateProjectLabel,
  INBOX_LABEL,
  acquireLock,
  releaseLock,
  markerPath,
  canonicalProjectPath,
  CANONICAL_PROJECT_FILENAME,
  MARKER_FILENAME,
  MARKER_VERSION,
  MARKER_LOCK,
  LOCK_TTL_MS,
  isSessionLocked,
  type ProjectMarker,
  type ProjectMarkerInput,
  type MarkerLocation,
  type FindMarkerOptions,
  type MarkerDiscoveryPolicy,
} from './marker.js';

export {
  rebalanceBatch,
  type RebalanceResult,
  type RebalanceSkip,
} from './rebalance.js';

export {
  onSessionStop,
  maybeSpawnSummarizer,
  buildSummarizerCommand,
  spawnSummarizer,
  detachedSpawner,
  summarizerLogPath,
  DEFAULT_SUMMARIZER_TIMEOUT_SEC,
  type SpawnContext,
  type Spawner,
  type SessionStopResult,
  type SessionStopReason,
  type MaybeSpawnSummarizerOptions,
} from './session-hooks.js';
