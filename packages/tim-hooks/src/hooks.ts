import { spawn } from 'child_process';
import type { HooksConfig } from 'tim-core';
import { normalizeHookScripts } from 'tim-core';

export interface HookEnv {
  TIM_SESSION_ID?: string;
  TIM_CWD?: string;
  TIM_AGENT?: string;
  TIM_HARNESS?: string;
  [key: string]: string | undefined;
}

export interface RunHooksOptions {
  scripts?: string | string[];
  env?: HookEnv;
  timeoutMs?: number;
  cwd?: string;
}

export interface HookRunResult {
  script: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

export async function runHookScript(
  script: string,
  options: Omit<RunHooksOptions, 'scripts'> = {},
): Promise<HookRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env = { ...process.env, ...options.env };

  return new Promise((resolve) => {
    const child = spawn(script, {
      shell: true,
      env,
      cwd: options.cwd,
      stdio: 'ignore',
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        script,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: err.message,
      });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        script,
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

export async function runHooks(options: RunHooksOptions = {}): Promise<HookRunResult[]> {
  const scripts = normalizeHookScripts(options.scripts);
  const results: HookRunResult[] = [];

  for (const script of scripts) {
    const result = await runHookScript(script, options);
    results.push(result);

    if (result.error) {
      console.error(`[tim-hooks] hook failed to start (${script}): ${result.error}`);
    } else if (result.timedOut) {
      console.error(`[tim-hooks] hook timed out (${script}) after ${options.timeoutMs ?? 30_000}ms`);
    } else if (result.exitCode !== 0) {
      console.error(`[tim-hooks] hook exited with code ${result.exitCode} (${script})`);
    }
  }

  return results;
}

export async function runConfiguredHooks(
  hookName: keyof Pick<HooksConfig, 'sessionStart' | 'sessionEnd'>,
  hooksConfig: HooksConfig | undefined,
  env: HookEnv,
): Promise<HookRunResult[]> {
  if (hooksConfig?.enabled === false) {
    return [];
  }

  const scripts = hooksConfig?.[hookName];
  return runHooks({
    scripts,
    env,
    timeoutMs: hooksConfig?.timeoutMs ?? 30_000,
    cwd: env.TIM_CWD,
  });
}
