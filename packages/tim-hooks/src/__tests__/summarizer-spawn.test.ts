import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn as nodeSpawn } from 'child_process';
import {
  runSupervisor,
  isProcessGroupAlive,
  safeKillProcessGroup,
} from '../summarizer-supervisor.js';
import { summarizerLockPath, releaseLock } from '../marker.js';

const TEST_ROOT = path.join(os.tmpdir(), 'tim-test-runs');

function logPathFor(cwd: string): string {
  return path.join(cwd, '.tim', 'summarizer.log');
}

function metacharDir(): string {
  return fs.mkdtempSync(path.join(TEST_ROOT, 'spawn ')) + ` $HOME ' \`tick\``;
}

function writeFakeSummarizeScript(
  dir: string,
  behavior: 'ok' | 'slow' | 'fail',
): string {
  const script = path.join(dir, 'fake-summarize.js');
  const bodies: Record<'ok' | 'slow' | 'fail', string> = {
    ok: `
      const fs = require('fs');
      const path = require('path');
      const out = process.env.TIM_OUT || path.join(process.cwd(), '.tim', 'child.json');
      fs.writeFileSync(out, JSON.stringify({
        argv: process.argv.slice(2),
        sessionId: process.env.TIM_SESSION_ID,
        summarizer: process.env.TIM_SUMMARIZER,
        cwd: process.cwd(),
      }));
      process.exit(0);
    `,
    slow: `setTimeout(() => process.exit(0), 60_000);`,
    fail: `process.exit(2);`,
  };
  fs.writeFileSync(script, bodies[behavior]);
  return script;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

describe('summarizer spawn lifecycle', () => {
  let dir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = metacharDir();
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    releaseLock(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes argv and env through supervisor without shell interpretation', async () => {
    const fakeScript = writeFakeSummarizeScript(dir, 'ok');
    const childOut = path.join(dir, '.tim', 'child.json');
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));

    const sessionId = `sess with spaces $ "' \`x\``;
    await runSupervisor({
      lockPath,
      logPath,
      timeoutSec: 5,
      sessionId,
      summarizeScript: fakeScript,
      cwd: dir,
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(childOut)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(childOut, 'utf8')) as {
      argv: string[];
      sessionId: string;
      summarizer: string;
      cwd: string;
    };
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.summarizer).toBe('1');
    expect(payload.cwd).toBe(dir);
    expect(payload.argv).toEqual([]);
  });

  it('settles immediately and releases the lock when spawn has no PID', async () => {
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'locked');
    const code = await runSupervisor({
      cwd: path.join(dir, 'missing-directory'), lockPath, logPath,
      sessionId: 'failed-spawn', timeoutSec: 60,
      summarizeScript: path.join(dir, 'unused.js'),
    });
    expect(code).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('summarizer child error');
  });

  it('does not probe or signal invalid process group identifiers', () => {
    for (const pid of [undefined, NaN, 0, -1, 1.5]) {
      expect(isProcessGroupAlive(pid)).toBe(false);
      expect(safeKillProcessGroup(pid, 'SIGTERM')).toBe(false);
    }
  });

  it('releases lock on timeout and records it in the log', async () => {
    const fakeScript = writeFakeSummarizeScript(dir, 'slow');
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));

    const code = await runSupervisor({
      lockPath,
      logPath,
      timeoutSec: 1,
      sessionId: 'sid',
      summarizeScript: fakeScript,
      cwd: dir,
    });

    expect(code).toBe(124);
    expect(fs.existsSync(lockPath)).toBe(false);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('timed out after 1s');
  });

  it('releases lock when summarize child exits with failure', async () => {
    const fakeScript = writeFakeSummarizeScript(dir, 'fail');
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));

    const code = await runSupervisor({
      lockPath,
      logPath,
      timeoutSec: 5,
      sessionId: 'sid',
      summarizeScript: fakeScript,
      cwd: dir,
    });

    expect(code).toBe(2);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('runSupervisor releases lock when summarize script is missing', async () => {
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));

    await runSupervisor({
      lockPath,
      logPath,
      timeoutSec: 1,
      sessionId: 'sid',
      summarizeScript: path.join(dir, 'missing-summarize.js'),
      cwd: dir,
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toMatch(/error|ENOENT/i);
  });

  it('detached spawn passes argument array to node without shell', async () => {
    const fakeScript = writeFakeSummarizeScript(dir, 'ok');
    const out = path.join(dir, '.tim', 'argv.json');
    process.env.TIM_OUT = out;
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));

    const supervisor = path.resolve(__dirname, '../../dist/summarizer-supervisor.js');
    expect(fs.existsSync(supervisor)).toBe(true);
    const args = [
      supervisor,
      '--lock-path',
      lockPath,
      '--log-path',
      logPath,
      '--timeout-sec',
      '5',
      '--session-id',
      `id with $ "' \`meta\``,
      '--summarize-script',
      fakeScript,
      '--cwd',
      dir,
    ];

    const child = nodeSpawn(process.execPath, args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TIM_OUT: out },
    });
    child.unref();

    await waitFor(() => !fs.existsSync(lockPath) && fs.existsSync(out), 8_000);
    expect(fs.existsSync(out)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(out, 'utf8')) as { sessionId: string };
    expect(payload.sessionId).toBe(`id with $ "' \`meta\``);
  });

  it('keeps lock and escalates until a SIGTERM-ignoring grandchild exits', async () => {
    const script = path.join(dir, 'spawn-grandchild.js');
    fs.writeFileSync(
      script,
      `
        const { spawn } = require('child_process');
        const grandchild = spawn(process.execPath, ['-e', \`
          process.on('SIGTERM', () => {});
          const fs = require('fs');
          const marker = process.env.TIM_GRANDCHILD_MARKER;
          if (marker) fs.writeFileSync(marker, 'alive');
          setTimeout(() => {
            if (marker) fs.writeFileSync(marker, 'done');
            process.exit(0);
          }, 2500);
        \`], { stdio: 'ignore' });
        grandchild.unref();
        process.exit(0);
      `,
    );
    const lockPath = summarizerLockPath(dir);
    const logPath = logPathFor(dir);
    const marker = path.join(dir, '.tim', 'grandchild.txt');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));
    process.env.TIM_GRANDCHILD_MARKER = marker;

    const start = Date.now();
    const code = await runSupervisor({
      lockPath,
      logPath,
      timeoutSec: 1,
      sessionId: 'grandchild-sid',
      summarizeScript: script,
      cwd: dir,
    });
    const elapsed = Date.now() - start;

    expect(code).toBe(124);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('done');
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(15_000);
    delete process.env.TIM_GRANDCHILD_MARKER;
  });

  it('safeKillProcessGroup skips already-reaped process groups', () => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pgid = child.pid!;
    child.unref();
    return new Promise<void>((resolve, reject) => {
      child.on('exit', () => {
        setTimeout(() => {
          try {
            expect(isProcessGroupAlive(pgid)).toBe(false);
            expect(safeKillProcessGroup(pgid, 'SIGKILL')).toBe(false);
            resolve();
          } catch (err) {
            reject(err);
          }
        }, 100);
      });
    });
  });
});
