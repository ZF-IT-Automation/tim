import { spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { releaseLock } from './marker.js';

export interface SummarizerSpawnRequest {
  sessionId: string;
  cwd: string;
  lockPath: string;
  logPath: string;
  timeoutSec: number;
  /** When set, run summarize.js in --project-summary mode (no session lock). */
  projectSummaryLabel?: string;
}

export type Spawner = (request: SummarizerSpawnRequest) => void;

export interface SpawnContext {
  sessionId: string;
  cwd: string;
}

export function resolveSummarizeScriptPath(): string {
  return path.resolve(__dirname, '..', '..', 'tim-summarizer', 'dist', 'summarize.js');
}

export function resolveSupervisorScriptPath(): string {
  const besideModule = path.resolve(__dirname, 'summarizer-supervisor.js');
  if (fs.existsSync(besideModule)) return besideModule;
  const packageDist = path.resolve(__dirname, '..', 'dist', 'summarizer-supervisor.js');
  if (fs.existsSync(packageDist)) return packageDist;
  return besideModule;
}

export function buildSummarizerSpawnRequest(
  sessionId: string,
  cwd: string,
  lockPath: string,
  logPath: string,
  timeoutSec: number,
): SummarizerSpawnRequest {
  return { sessionId, cwd, lockPath, logPath, timeoutSec };
}

export function buildProjectSummarySpawnRequest(
  label: string,
  cwd: string,
  logPath: string,
  timeoutSec: number,
): SummarizerSpawnRequest {
  return {
    sessionId: label,
    cwd,
    lockPath: '',
    logPath,
    timeoutSec,
    projectSummaryLabel: label,
  };
}

function appendSpawnError(logPath: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn error: ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function supervisorArgv(request: SummarizerSpawnRequest): string[] {
  const args = [
    resolveSupervisorScriptPath(),
    '--lock-path',
    request.lockPath,
    '--log-path',
    request.logPath,
    '--timeout-sec',
    String(request.timeoutSec),
    '--session-id',
    request.sessionId,
    '--summarize-script',
    resolveSummarizeScriptPath(),
    '--cwd',
    request.cwd,
  ];
  if (request.projectSummaryLabel) {
    args.push('--project-summary', request.projectSummaryLabel);
  }
  return args;
}

/** Detached spawn via argv-only supervisor; releases lock on launch errors. */
export const spawnSummarizer: Spawner = request => {
  const timDir = path.join(request.cwd, '.tim');
  try {
    fs.mkdirSync(timDir, { recursive: true });
  } catch {
    /* ignore */
  }

  try {
    const child = nodeSpawn(process.execPath, supervisorArgv(request), {
      shell: false,
      cwd: request.cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', err => {
      appendSpawnError(request.logPath, err);
      if (request.lockPath) releaseLock(request.cwd);
    });
    child.unref();
  } catch (err) {
    appendSpawnError(request.logPath, err);
    if (request.lockPath) releaseLock(request.cwd);
  }
};

/** @deprecated Use spawnSummarizer */
export const detachedSpawner: Spawner = spawnSummarizer;
