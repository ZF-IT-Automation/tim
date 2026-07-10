import { spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import {
  detectProject,
  reconcileMarker,
  acquireLock,
  releaseLock,
  MARKER_LOCK,
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
    `timeout ${timeoutSec} env TIM_SESSION_ID=${q(sessionId)} ${cmd} >>${q(logPath)} 2>&1; }`
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
      env: { ...process.env, TIM_SESSION_ID: ctx.sessionId },
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

  const reconciled = await reconcileMarker(store, cwd);
  const pending = reconciled.exchanges - reconciled.batches_summarized * reconciled.batch_size;
  if (!opts.batchFull && pending < reconciled.batch_size) {
    return { spawned: false, reason: 'below-threshold', pending };
  }

  if (!acquireLock(cwd)) return { spawned: false, reason: 'locked', pending };

  const lockPath = path.join(cwd, MARKER_LOCK);
  const logPath = summarizerLogPath(cwd);
  const timeoutSec = opts.timeoutSec ?? DEFAULT_SUMMARIZER_TIMEOUT_SEC;

  try {
    spawn(buildSummarizerCommand(reconciled.session, lockPath, logPath, timeoutSec), {
      sessionId: reconciled.session,
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
