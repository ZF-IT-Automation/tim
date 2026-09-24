#!/usr/bin/env node
/**
 * Detached summarizer supervisor — runs summarize.js with a bounded timeout,
 * appends output to the project log, and always releases the summarizer lock.
 * Invoked via argv arrays only; paths with shell metacharacters are safe.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';

const SUMMARIZER_ENV_FLAG = 'TIM_SUMMARIZER';

export interface SupervisorOptions {
  lockPath: string;
  logPath: string;
  timeoutSec: number;
  sessionId: string;
  summarizeScript: string;
  cwd: string;
  projectSummaryLabel?: string;
}

export function parseSupervisorArgv(argv: string[]): SupervisorOptions {
  const opts: Partial<SupervisorOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--lock-path':
        opts.lockPath = next;
        i++;
        break;
      case '--log-path':
        opts.logPath = next;
        i++;
        break;
      case '--timeout-sec':
        opts.timeoutSec = Number(next);
        i++;
        break;
      case '--session-id':
        opts.sessionId = next;
        i++;
        break;
      case '--summarize-script':
        opts.summarizeScript = next;
        i++;
        break;
      case '--cwd':
        opts.cwd = next;
        i++;
        break;
      case '--project-summary':
        opts.projectSummaryLabel = next;
        i++;
        break;
      default:
        break;
    }
  }
  if (
    opts.lockPath === undefined ||
    !opts.logPath ||
    !opts.sessionId ||
    !opts.summarizeScript ||
    !opts.cwd ||
    typeof opts.timeoutSec !== 'number' ||
    !Number.isFinite(opts.timeoutSec) ||
    opts.timeoutSec <= 0
  ) {
    throw new Error('summarizer-supervisor: missing or invalid required arguments');
  }
  return opts as SupervisorOptions;
}

function releaseLock(lockPath: string): void {
  if (!lockPath) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* ignore */
  }
}

function appendLog(logPath: string, chunk: string | Buffer): void {
  try {
    fs.appendFileSync(logPath, chunk);
  } catch {
    /* ignore */
  }
}

/** True when process group `pgid` still has at least one live member. */
export function isProcessGroupAlive(pgid: number | undefined): boolean {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM: group exists but we lack signal rights — treat as alive.
    return true;
  }
}

/** Best-effort signal delivery; an existence probe is not a process identity guarantee. */
export function safeKillProcessGroup(pgid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pgid === undefined || !isProcessGroupAlive(pgid)) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (safeKillProcessGroup(pid, signal)) return;
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

function waitForProcessGroupExit(pgid: number | undefined, pollMs = 100): Promise<void> {
  return new Promise(resolve => {
    const tick = () => {
      if (!isProcessGroupAlive(pgid)) {
        resolve();
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/** Run the supervised summarizer lifecycle (exported for tests). */
export async function runSupervisor(opts: SupervisorOptions): Promise<number> {
  let exitCode = 1;
  let timedOut = false;
  let child: ReturnType<typeof spawn> | undefined;

  const onExit = () => releaseLock(opts.lockPath);
  process.on('exit', onExit);

  try {
    const summarizeArgs = [opts.summarizeScript];
    if (opts.projectSummaryLabel) {
      summarizeArgs.push('--project-summary', opts.projectSummaryLabel);
    }

    child = spawn(process.execPath, summarizeArgs, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        TIM_SESSION_ID: opts.sessionId,
        [SUMMARIZER_ENV_FLAG]: '1',
        // The summarizer splits this across its chain so a hung slot 1 still leaves room for slot 2.
        TIM_SUMMARIZER_BUDGET_SEC: String(opts.timeoutSec),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', chunk => appendLog(opts.logPath, chunk));
    child.stderr?.on('data', chunk => appendLog(opts.logPath, chunk));

    const pgid = child.pid;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let childExitCode = 1;
    let childExited = false;

    const timer = setTimeout(() => {
      timedOut = true;
      safeKillProcessGroup(pgid, 'SIGTERM');
      killTimer = setTimeout(() => {
        safeKillProcessGroup(pgid, 'SIGKILL');
      }, 5_000);
    }, opts.timeoutSec * 1000);

    exitCode = await new Promise<number>(resolve => {
      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      const maybeSettle = () => {
        if (childExited && !isProcessGroupAlive(pgid)) {
          settle(childExitCode);
        }
      };

      child!.on('error', err => {
        appendLog(
          opts.logPath,
          `[${new Date().toISOString()}] summarizer child error: ${err.message}\n`,
        );
        childExited = true;
        childExitCode = 1;
        maybeSettle();
      });
      child!.on('exit', code => {
        childExited = true;
        childExitCode = code ?? 1;
        maybeSettle();
      });

      const poll = () => {
        if (settled) return;
        if (childExited && !isProcessGroupAlive(pgid)) {
          settle(childExitCode);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });

    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    await waitForProcessGroupExit(pgid);
    if (timedOut) {
      appendLog(
        opts.logPath,
        `[${new Date().toISOString()}] summarizer timed out after ${opts.timeoutSec}s\n`,
      );
      exitCode = 124;
    }
  } finally {
    releaseLock(opts.lockPath);
    process.off('exit', onExit);
  }

  return exitCode;
}

async function main(): Promise<void> {
  try {
    const opts = parseSupervisorArgv(process.argv.slice(2));
    const code = await runSupervisor(opts);
    process.exitCode = code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`summarizer-supervisor: ${msg}\n`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('summarizer-supervisor.js') ||
    process.argv[1].endsWith('summarizer-supervisor.ts'));

if (isMain) {
  void main();
}
