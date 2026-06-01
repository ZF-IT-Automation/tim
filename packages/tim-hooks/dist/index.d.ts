export { runHookScript, runHooks, runConfiguredHooks, type HookEnv, type HookRunResult, type RunHooksOptions, } from './hooks.js';
export { runCheckpoint, runSessionStart, runSessionEnd, loadProjectContext, getActiveProjectLabel, type SessionEndOptions, type SessionStartResult, } from './checkpoint.js';
export { readMarker, writeMarker, detectProject, reconcileMarker, acquireLock, releaseLock, markerPath, MARKER_FILENAME, MARKER_LOCK, LOCK_TTL_MS, type ProjectMarker, type SummarizerConfig, } from './marker.js';
export { onSessionStop, detachedSpawner, type SpawnContext, type Spawner, type SessionStopResult, } from './session-hooks.js';
//# sourceMappingURL=index.d.ts.map