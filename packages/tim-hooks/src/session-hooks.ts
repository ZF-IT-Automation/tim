import { spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  deriveCounters,
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

export interface SpawnContext {
  sessionId: string;
  cwd: string;
}

export type Spawner = (command: string, ctx: SpawnContext) => void;

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

/** Shell snippet: trap lock release, timeout, run tim-summarizer CLI with log append. */
export function buildSummarizerCommand(
  sessionId: string,
  lockPath: string,
  logPath: string,
  timeoutSec: number = DEFAULT_SUMMARIZER_TIMEOUT_SEC,
): string {
  const q = (s: string) => JSON.stringify(s);
  const cmd = 'node ' + JSON.stringify(path.resolve(__dirname, '..', '..', 'tim-summarizer', 'dist', 'summarize.js'));
  return (
    `{ trap ${q(`rm -f ${lockPath}`)} EXIT; ` +
    `timeout ${timeoutSec} env ${SUMMARIZER_ENV_FLAG}=1 TIM_SESSION_ID=${q(sessionId)} ${cmd} >>${q(logPath)} 2>&1; }`
  );
}

/** Detached spawn with log dir creation and spawn-error capture (does not throw). */
export const spawnSummarizer: Spawner = (command, ctx) => {
  const timDir = path.join(ctx.cwd, '.tim');
  try {
    fs.mkdirSync(timDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const logPath = summarizerLogPath(ctx.cwd);
  try {
    const child = nodeSpawn(command, {
      shell: true,
      cwd: ctx.cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TIM_SESSION_ID: ctx.sessionId, [SUMMARIZER_ENV_FLAG]: '1' },
    });
    child.on('error', err => {
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn error: ${err.message}\n`);
      } catch {
        /* ignore */
      }
      releaseLock(ctx.cwd);
    });
    child.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn failed: ${msg}\n`);
    } catch {
      /* ignore */
    }
    releaseLock(ctx.cwd);
  }
};

/** @deprecated Use spawnSummarizer */
export const detachedSpawner: Spawner = spawnSummarizer;

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
    spawn(buildSummarizerCommand(sessionId, lockPath, logPath, timeoutSec), {
      sessionId,
      cwd,
    });
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

export interface IdleSweepOptions {
  idleMinutes?: number;
  maxSpawnsPerPass?: number;
  /** Reserved for issue #20 — attempt counter / give-up after repeated failures. */
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

/**
 * Walk all sessions and spawn the summarizer for idle ones with pending exchanges.
 * Always passes sessionId explicitly — never resolves by cwd.
 * Scan cost on the live DB (389 sessions): listing 7 ms, deriveCounters 223 ms.
 */
export async function sweepIdleSessions(
  store: TimStore,
  opts: IdleSweepOptions = {},
): Promise<IdleSweepResult[]> {
  const idleMinutes = opts.idleMinutes ?? 15;
  const maxSpawns = opts.maxSpawnsPerPass ?? 3;
  const nowMs = opts.now ?? (() => Date.now());
  const idleCutoff = new Date(nowMs() - idleMinutes * 60_000).toISOString();
  const errorLogger = new ErrorLogger(store.getDb());
  const loggedSkip = new Set<string>();
  const results: IdleSweepResult[] = [];
  let spawns = 0;

  const sessions = await store.getByMetadataKind(KIND_SESSION, ALL_SESSIONS);
  for (const session of sessions) {
    if (spawns >= maxSpawns) break;

    const sessionId = session.id;
    const batchSize = typeof session.metadata.batch_size === 'number'
      ? session.metadata.batch_size
      : 5;
    const { exchangeCount, batchesSummarized } = await deriveCounters(store, sessionId);
    const pending = exchangeCount - batchesSummarized * batchSize;
    if (pending <= 0) continue;

    const lastAt = await getSessionLastExchangeAt(store, sessionId);
    if (!lastAt || lastAt > idleCutoff) {
      results.push({ sessionId, reason: 'not-idle' });
      continue;
    }

    const cwdRaw = session.metadata.cwd;
    if (typeof cwdRaw !== 'string' || !cwdRaw.trim()) {
      const key = `${sessionId}:no-cwd`;
      if (!loggedSkip.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error: 'session missing metadata.cwd — skipped',
          sessionId,
        });
        loggedSkip.add(key);
      }
      results.push({ sessionId, reason: 'no-cwd' });
      continue;
    }
    const cwd = cwdRaw.trim();

    if (!fs.existsSync(cwd)) {
      const key = `${sessionId}:missing-dir`;
      if (!loggedSkip.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error: `session cwd does not exist: ${cwd}`,
          sessionId,
        });
        loggedSkip.add(key);
      }
      results.push({ sessionId, reason: 'no-cwd' });
      continue;
    }

    if (!detectProject(cwd)) {
      const key = `${sessionId}:no-marker`;
      if (!loggedSkip.has(key)) {
        errorLogger.logError({
          tool: 'idle_sweep',
          error: `session cwd has no .tim-project marker: ${cwd}`,
          sessionId,
        });
        loggedSkip.add(key);
      }
      results.push({ sessionId, reason: 'no-marker' });
      continue;
    }

    const res = await maybeSpawnSummarizer(store, cwd, {
      spawn: opts.spawn,
      batchFull: true,
      sessionId,
    });
    results.push({ sessionId, reason: res.reason });
    if (res.spawned) spawns++;
  }

  return results;
}

export const DEFAULT_PROJECT_SUMMARY_THRESHOLD = 5;

/** Shell snippet: run tim-summarizer in --project-summary mode for a label. */
export function buildProjectSummaryCommand(
  label: string,
  logPath: string,
  timeoutSec: number = DEFAULT_SUMMARIZER_TIMEOUT_SEC,
): string {
  const q = (s: string) => JSON.stringify(s);
  const cmd = 'node ' + JSON.stringify(path.resolve(__dirname, '..', '..', 'tim-summarizer', 'dist', 'summarize.js'));
  return `timeout ${timeoutSec} ${cmd} --project-summary ${q(label)} >>${q(logPath)} 2>&1`;
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
    spawn(buildProjectSummaryCommand(label, logPath, timeoutSec), { sessionId: label, cwd });
    return { spawned: true, reason: 'spawned', count };
  } catch {
    return { spawned: false, reason: 'spawn-failed', count };
  }
}
