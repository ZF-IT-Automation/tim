import * as fs from 'fs';
import * as path from 'path';
import {
  deriveCounters,
  deriveSessionCoverage,
  resolveCurrentSession,
  findChildByKind,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
  ErrorLogger,
  type TimStore,
} from 'tim-store';
import {
  detectProject,
  acquireLock,
  releaseLock,
  summarizerLockPath,
} from './marker.js';
import { DEFAULT_SUMMARIZER_TIMEOUT_SEC } from './constants.js';
import {
  buildProjectSummarySpawnRequest,
  buildSummarizerSpawnRequest,
  spawnSummarizer,
  type SpawnContext,
  type Spawner,
  type SummarizerSpawnRequest,
} from './summarizer-spawn.js';

export type { SpawnContext, Spawner, SummarizerSpawnRequest } from './summarizer-spawn.js';
export {
  buildSummarizerSpawnRequest,
  buildProjectSummarySpawnRequest,
  spawnSummarizer,
  detachedSpawner,
  resolveSummarizeScriptPath,
  resolveSupervisorScriptPath,
} from './summarizer-spawn.js';

export type SessionStopReason =
  | 'spawned'
  | 'no-marker'
  | 'no-session'
  | 'below-threshold'
  | 'locked'
  | 'spawn-failed';

export interface SessionStopResult {
  spawned: boolean;
  reason: SessionStopReason;
  pending?: number;
}

export { DEFAULT_SUMMARIZER_TIMEOUT_SEC } from './constants.js';

export function summarizerLogPath(cwd: string): string {
  return path.join(cwd, '.tim', 'summarizer.log');
}

/**
 * Marks every process below the summarizer spawn. The summarizer runs agent CLIs
 * (codex, opencode) inside the project directory, so those children are themselves
 * hook-registered agent sessions: without this flag their hooks log the summarizer's
 * own prompt back into TIM as a user exchange, and the summarizer ends up feeding
 * itself. Inherited by every descendant process.
 */
export const SUMMARIZER_ENV_FLAG = 'TIM_SUMMARIZER';

/** True inside the summarizer's process tree — hooks must not write or brief there. */
export function isSummarizerChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUMMARIZER_ENV_FLAG] === '1';
}

/** team-up worker flag — workers must not create sessions or log exchanges. */
export const TEAMUP_WORKER_ENV_FLAG = 'TEAMUP_WORKER';

/** True when spawned as a team-up worker; session hooks and MCP session tools no-op. */
export function isTeamupWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEAMUP_WORKER_ENV_FLAG] === '1';
}

/**
 * @deprecated Shell-based spawn removed — use {@link buildSummarizerSpawnRequest} with
 * {@link spawnSummarizer} instead.
 */
export function buildSummarizerCommand(
  _sessionId: string,
  _lockPath: string,
  _logPath: string,
  _timeoutSec: number = DEFAULT_SUMMARIZER_TIMEOUT_SEC,
): string {
  throw new Error(
    'buildSummarizerCommand was removed in tim-hooks beta: '
    + 'use buildSummarizerSpawnRequest() with spawnSummarizer() instead of exec()',
  );
}

export interface MaybeSpawnSummarizerOptions {
  spawn?: Spawner;
  /** Skip pending threshold — use when a batch just filled (live trigger). */
  batchFull?: boolean;
  timeoutSec?: number;
  /** Session to summarize; when omitted, resolved from the store for marker.project + cwd. */
  sessionId?: string;
}

/** Shared spawn gate for session-stop hook and live batch-full trigger. */
export async function maybeSpawnSummarizer(
  store: TimStore,
  cwd: string,
  opts: MaybeSpawnSummarizerOptions = {},
): Promise<SessionStopResult> {
  const spawn = opts.spawn ?? spawnSummarizer;

  const marker = detectProject(cwd);
  if (!marker) return { spawned: false, reason: 'no-marker' };

  const sessionEntry = opts.sessionId
    ? await store.read(opts.sessionId)
    : await resolveCurrentSession(store, marker.project, cwd);
  if (!sessionEntry) return { spawned: false, reason: 'no-session' };

  const sessionId = sessionEntry.id;
  const batchSize = typeof sessionEntry.metadata.batch_size === 'number'
    ? sessionEntry.metadata.batch_size
    : 5;
  const { exchangeCount, batchesSummarized } = await deriveCounters(store, sessionId);
  const pending = exchangeCount - batchesSummarized * batchSize;
  if (!opts.batchFull && pending < batchSize) {
    return { spawned: false, reason: 'below-threshold', pending };
  }

  if (!acquireLock(cwd)) return { spawned: false, reason: 'locked', pending };

  const lockPath = summarizerLockPath(cwd);
  const logPath = summarizerLogPath(cwd);
  const timeoutSec = opts.timeoutSec ?? DEFAULT_SUMMARIZER_TIMEOUT_SEC;

  try {
    spawn(buildSummarizerSpawnRequest(sessionId, cwd, lockPath, logPath, timeoutSec));
    return { spawned: true, reason: 'spawned', pending };
  } catch {
    releaseLock(cwd);
    return { spawned: false, reason: 'spawn-failed', pending };
  }
}

export async function onSessionStop(
  store: TimStore,
  cwd: string,
  opts: { spawn?: Spawner; timeoutSec?: number } = {},
): Promise<SessionStopResult> {
  return maybeSpawnSummarizer(store, cwd, opts);
}

const ALL_SESSIONS = 1_000_000;
const KIND_SESSION = 'session';
/** Session metadata — absent means 0. Reset when batchesSummarized increases. */
const SWEEP_ATTEMPTS_KEY = 'sweep_attempts';
/** batchesSummarized at last sweep spawn — compared on the next pass. */
const SWEEP_BATCHES_AT_SPAWN_KEY = 'sweep_batches_at_spawn';

/**
 * Sessions already reported as unsweepable, for the life of this process. A broken
 * cwd does not heal between ticks, so a per-pass set would write the same row every
 * `interval_minutes` — 288 rows a day per broken session, against a log that rotates
 * at 10k. Process-scoped is the right lifetime: it survives the ticks, and a restart
 * is exactly when the situation may have changed.
 */
const sweepSkipLogged = new Set<string>();

export interface IdleSweepOptions {
  idleMinutes?: number;
  maxSpawnsPerPass?: number;
  /** Give up after this many spawns that produced no new summary (default 3). */
  maxAttempts?: number;
  spawn?: Spawner;
  now?: () => number;
}

export type IdleSweepReason =
  | SessionStopReason
  | 'no-cwd'
  | 'not-idle'
  | 'no-pending'
  | 'exhausted';

export interface IdleSweepResult {
  sessionId: string;
  reason: IdleSweepReason;
}

/** Latest exchange timestamp anywhere in the session's Exchanges subtree. */
async function getSessionLastExchangeAt(
  store: TimStore,
  sessionId: string,
): Promise<string | null> {
  const exNode = await findChildByKind(store, sessionId, KIND_EXCHANGES_ROOT);
  if (!exNode) return null;

  let latest: string | null = null;
  const consider = (createdAt: string) => {
    if (!latest || createdAt > latest) latest = createdAt;
  };

  const batches = await store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH);
  for (const batch of batches) {
    const children = await store.getChildrenBySeq(batch.id);
    for (const child of children) {
      consider(child.createdAt);
      const replies = await store.getChildren(child.id);
      for (const r of replies) consider(r.createdAt);
    }
  }
  return latest;
}

function getSweepAttempts(metadata: Record<string, unknown>): number {
  const v = metadata[SWEEP_ATTEMPTS_KEY];
  return typeof v === 'number' && v >= 0 ? v : 0;
}

function getSweepBatchesAtSpawn(metadata: Record<string, unknown>): number | undefined {
  const v = metadata[SWEEP_BATCHES_AT_SPAWN_KEY];
  return typeof v === 'number' ? v : undefined;
}

async function patchSessionSweepMetadata(
  store: TimStore,
  sessionId: string,
  patch: { sweepAttempts?: number; sweepBatchesAtSpawn?: number | null },
): Promise<Record<string, unknown>> {
  const session = await store.read(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const next = { ...session.metadata } as Record<string, unknown>;
  if (patch.sweepAttempts !== undefined) {
    if (patch.sweepAttempts <= 0) next[SWEEP_ATTEMPTS_KEY] = null;
    else next[SWEEP_ATTEMPTS_KEY] = patch.sweepAttempts;
  }
  if (patch.sweepBatchesAtSpawn !== undefined) {
    if (patch.sweepBatchesAtSpawn === null) next[SWEEP_BATCHES_AT_SPAWN_KEY] = null;
    else next[SWEEP_BATCHES_AT_SPAWN_KEY] = patch.sweepBatchesAtSpawn;
  }
  await store.update(sessionId, { metadata: next });
  return next;
}

/**
 * Walk all sessions and spawn the summarizer for idle ones with pending exchanges.
 * Always passes sessionId explicitly — never resolves by cwd.
 * Scan cost scales with session count; deriveSessionCoverage reuses one child fetch per batch.
 */
export async function sweepIdleSessions(
  store: TimStore,
  opts: IdleSweepOptions = {},
): Promise<IdleSweepResult[]> {
  const idleMinutes = opts.idleMinutes ?? 15;
  const maxSpawns = opts.maxSpawnsPerPass ?? 3;
  const maxAttempts = opts.maxAttempts ?? 3;
  const nowMs = opts.now ?? (() => Date.now());
  const idleCutoff = new Date(nowMs() - idleMinutes * 60_000).toISOString();
  const errorLogger = new ErrorLogger(store.getDb());
  const results: IdleSweepResult[] = [];
  let spawns = 0;

  const sessions = await store.getByMetadataKind(KIND_SESSION, ALL_SESSIONS);
  for (const session of sessions) {
    if (spawns >= maxSpawns) break;

    const sessionId = session.id;
    const coverage = await deriveSessionCoverage(store, sessionId);
    const { batchesSummarized } = coverage;
    if (!coverage.hasPendingSummarization) {
      results.push({ sessionId, reason: 'no-pending' });
      continue;
    }

    const lastAt = await getSessionLastExchangeAt(store, sessionId);
    if (!lastAt || lastAt > idleCutoff) {
      results.push({ sessionId, reason: 'not-idle' });
      continue;
    }

    const cwdRaw = session.metadata.cwd;
    if (typeof cwdRaw !== 'string' || !cwdRaw.trim()) {
      const key = `${sessionId}:no-cwd`;
      if (!sweepSkipLogged.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error: 'session missing metadata.cwd — skipped',
          sessionId,
        });
        sweepSkipLogged.add(key);
      }
      results.push({ sessionId, reason: 'no-cwd' });
      continue;
    }
    const cwd = cwdRaw.trim();

    if (!fs.existsSync(cwd)) {
      const key = `${sessionId}:missing-dir`;
      if (!sweepSkipLogged.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error: `session cwd does not exist: ${cwd}`,
          sessionId,
        });
        sweepSkipLogged.add(key);
      }
      results.push({ sessionId, reason: 'no-cwd' });
      continue;
    }

    if (!detectProject(cwd)) {
      const key = `${sessionId}:no-marker`;
      if (!sweepSkipLogged.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error: `session cwd has no .tim-project marker: ${cwd}`,
          sessionId,
        });
        sweepSkipLogged.add(key);
      }
      results.push({ sessionId, reason: 'no-marker' });
      continue;
    }

    let sessionMeta = session.metadata as Record<string, unknown>;
    let attempts = getSweepAttempts(sessionMeta);
    const batchesAtSpawn = getSweepBatchesAtSpawn(sessionMeta);
    if (batchesAtSpawn !== undefined) {
      if (batchesSummarized > batchesAtSpawn) {
        attempts = 0;
        sessionMeta = await patchSessionSweepMetadata(store, sessionId, {
          sweepAttempts: 0,
          sweepBatchesAtSpawn: null,
        });
      } else {
        // Clear the marker along with the increment: it records one spawn, and this
        // pass has now judged it. Leaving it set would charge every later pass to the
        // same spawn — a `locked` cwd (the summarizer legitimately still running, up
        // to 600 s against a 5-minute tick) would exhaust three attempts without ever
        // getting a second spawn. One increment per spawn, which is what the criterion
        // says.
        attempts += 1;
        sessionMeta = await patchSessionSweepMetadata(store, sessionId, {
          sweepAttempts: attempts,
          sweepBatchesAtSpawn: null,
        });
      }
    }

    if (attempts >= maxAttempts) {
      const key = `${sessionId}:exhausted`;
      if (!sweepSkipLogged.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error:
            `session exhausted ${maxAttempts} idle-sweep attempts without a new summary — skipped`,
          sessionId,
        });
        sweepSkipLogged.add(key);
      }
      results.push({ sessionId, reason: 'exhausted' });
      continue;
    }

    const res = await maybeSpawnSummarizer(store, cwd, {
      spawn: opts.spawn,
      batchFull: true,
      sessionId,
    });
    results.push({ sessionId, reason: res.reason });
    if (res.spawned) {
      spawns++;
      await patchSessionSweepMetadata(store, sessionId, {
        sweepBatchesAtSpawn: batchesSummarized,
      });
    }
  }

  return results;
}

export const DEFAULT_PROJECT_SUMMARY_THRESHOLD = 5;

/**
 * @deprecated Shell-based spawn removed — use {@link buildProjectSummarySpawnRequest} with
 * {@link spawnSummarizer} instead.
 */
export function buildProjectSummaryCommand(
  _label: string,
  _logPath: string,
  _timeoutSec: number = DEFAULT_SUMMARIZER_TIMEOUT_SEC,
): string {
  throw new Error(
    'buildProjectSummaryCommand was removed in tim-hooks beta: '
    + 'use buildProjectSummarySpawnRequest() with spawnSummarizer() instead of exec()',
  );
}

export type ProjectSummaryReason =
  | 'spawned'
  | 'no-label'
  | 'no-sessions'
  | 'below-threshold'
  | 'spawn-failed';

export interface ProjectSummaryResult {
  spawned: boolean;
  reason: ProjectSummaryReason;
  count?: number;
}

export interface MaybeSpawnProjectSummaryOptions {
  spawn?: Spawner;
  threshold?: number;
  timeoutSec?: number;
}

/**
 * Gate + detached spawn for periodic project-summary generation.
 * Fires only when sessions-so-far is a positive multiple of the threshold.
 * Fire-and-forget — never throws.
 */
export async function maybeSpawnProjectSummary(
  store: TimStore,
  cwd: string,
  label: string | null,
  opts: MaybeSpawnProjectSummaryOptions = {},
): Promise<ProjectSummaryResult> {
  if (!label) return { spawned: false, reason: 'no-label' };

  const count = await store.countSessionSummaries(label);
  if (count <= 0) return { spawned: false, reason: 'no-sessions', count };

  const threshold = opts.threshold ?? DEFAULT_PROJECT_SUMMARY_THRESHOLD;
  if (threshold <= 0 || count % threshold !== 0) {
    return { spawned: false, reason: 'below-threshold', count };
  }

  const spawn = opts.spawn ?? spawnSummarizer;
  const logPath = summarizerLogPath(cwd);
  const timeoutSec = opts.timeoutSec ?? DEFAULT_SUMMARIZER_TIMEOUT_SEC;

  try {
    spawn(buildProjectSummarySpawnRequest(label, cwd, logPath, timeoutSec));
    return { spawned: true, reason: 'spawned', count };
  } catch {
    return { spawned: false, reason: 'spawn-failed', count };
  }
}
