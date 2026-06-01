export {
  runHookScript,
  runHooks,
  runConfiguredHooks,
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

export {
  readMarker,
  writeMarker,
  detectProject,
  findMarker,
  buildLoadDirective,
  reconcileMarker,
  acquireLock,
  releaseLock,
  markerPath,
  MARKER_FILENAME,
  MARKER_LOCK,
  LOCK_TTL_MS,
  type ProjectMarker,
  type MarkerLocation,
  type SummarizerConfig,
} from './marker.js';

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
