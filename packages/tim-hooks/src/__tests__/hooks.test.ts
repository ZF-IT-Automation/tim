import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadConfig,
  saveConfig,
  normalizeHookScripts,
  type TimConfigFile,
} from 'tim-core';
import { TimStore, SessionManager } from 'tim-store';
import {
  runHookScript,
  runHooks,
  runSessionEnd,
  runSessionStart,
} from '../index.js';

describe('config hooks parsing', () => {
  it('handles absent hooks (backward compatible)', () => {
    const config = loadConfig();
    expect(config.hooks?.enabled).not.toBe(false);
    expect(normalizeHookScripts(undefined)).toEqual([]);
  });

  it('normalizes string vs array scripts', () => {
    expect(normalizeHookScripts('echo hi')).toEqual(['echo hi']);
    expect(normalizeHookScripts(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('hook runner', () => {
  it('injects env vars', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-hook-'));
    const outFile = path.join(tmpDir, 'out.txt');
    const script = `echo "$TIM_SESSION_ID|$TIM_AGENT|$TIM_CWD" > "${outFile}"`;

    await runHookScript(script, {
      env: {
        TIM_SESSION_ID: 'sess-env',
        TIM_AGENT: 'test-agent',
        TIM_CWD: tmpDir,
      },
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const content = fs.readFileSync(outFile, 'utf8').trim();
    expect(content).toBe(`sess-env|test-agent|${tmpDir}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces timeout', async () => {
    const result = await runHookScript('sleep 5', { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
  });

  it('treats non-zero exit as non-fatal', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await runHooks({ scripts: 'exit 42', timeoutMs: 5000 });
    expect(results[0].exitCode).toBe(42);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('session-end checkpoint orchestration', () => {
  it('runs sessionEnd hooks then checkpoint', async () => {
    const store = new TimStore(':memory:');
    const sessions = new SessionManager(store);

    await sessions.sessionStart({
      sessionId: 'end-test',
      agentName: 'agent',
      cwd: '/',
      harness: 'test',
    });
    await sessions.sessionLog('end-test', [
      { role: 'user', content: 'done' },
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-end-'));
    const marker = path.join(tmpDir, 'ran.txt');
    const script = `touch "${marker}"`;

    const summary = await runSessionEnd(store, 'end-test', {
      hooksConfig: {
        sessionEnd: script,
        enabled: true,
        timeoutMs: 5000,
      },
      env: { TIM_CWD: tmpDir },
    });

    expect(fs.existsSync(marker)).toBe(true);
    expect(summary.metadata.kind).toBe('checkpoint');

    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.close();
  });

  it('session-start runs configured hook', async () => {
    const store = new TimStore(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-start-'));
    const marker = path.join(tmpDir, 'started.txt');
    const script = `touch "${marker}"`;

    await runSessionStart(store, {
      sessionId: 'start-test',
      agentName: 'agent',
      cwd: tmpDir,
      harness: 'test',
      hooksConfig: {
        sessionStart: script,
        enabled: true,
        timeoutMs: 5000,
      },
    });

    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.close();
  });

  it('loads project context when active-project file is set', async () => {
    const store = new TimStore(':memory:');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-proj-'));
    const originalHome = process.env.HOME;

    try {
      process.env.HOME = tmp;
      fs.mkdirSync(path.join(tmp, '.tim'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.tim', 'active-project'), 'P0099');

      await store.write('Project body', {
        metadata: { kind: 'project', label: 'P0099' },
        tags: ['#project'],
      });

      const result = await runSessionStart(store, {
        sessionId: 'proj-test',
        agentName: 'agent',
        cwd: '/tmp',
        harness: 'test',
      });

      expect(result.session.metadata.kind).toBe('session');
      expect(result.project?.metadata.label).toBe('P0099');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
      store.close();
    }
  });
});

describe('saveConfig roundtrip', () => {
  it('persists hooks config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-cfg-'));
    const configPath = path.join(tmp, '.tim', 'config.json');
    const originalHome = process.env.HOME;

    try {
      process.env.HOME = tmp;
      const config: TimConfigFile = {
        dbPath: path.join(tmp, 'tim.db'),
        deviceId: 'dev-1',
        hooks: {
          sessionStart: 'echo start',
          sessionEnd: ['echo end1', 'echo end2'],
          enabled: true,
          timeoutMs: 1234,
        },
      };
      saveConfig(config);
      const loaded = loadConfig();
      expect(loaded.hooks?.sessionStart).toBe('echo start');
      expect(loaded.hooks?.sessionEnd).toEqual(['echo end1', 'echo end2']);
      expect(loaded.hooks?.timeoutMs).toBe(1234);
      expect(fs.existsSync(configPath)).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
