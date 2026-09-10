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

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
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
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', chunk => appendLog(opts.logPath, chunk));
    child.stderr?.on('data', chunk => appendLog(opts.logPath, chunk));

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child!, 'SIGTERM');
      killTimer = setTimeout(() => killProcessTree(child!, 'SIGKILL'), 5_000);
    }, opts.timeoutSec * 1000);

    exitCode = await new Promise<number>(resolve => {
      child!.on('error', err => {
        appendLog(
          opts.logPath,
          `[${new Date().toISOString()}] summarizer child error: ${err.message}\n`,
        );
        resolve(1);
      });
      child!.on('exit', code => resolve(code ?? 1));
    });

    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
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
