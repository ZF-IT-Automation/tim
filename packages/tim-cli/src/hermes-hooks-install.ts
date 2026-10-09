import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Hermes gets one TIM hook from setup-agent: the pre_llm_call session cache, which
 * tells TIM which Hermes session and cwd are active. (The Hermes status bar, which
 * patched Hermes' cli.py, was removed on 2026-10-09 — Benni.)
 */
const CACHE_HOOK = 'tim-hermes-session-cache.sh';

export interface StepResult {
  step: string;
  status: 'ok' | 'skip' | 'warn' | 'fail';
  detail: string;
}

export interface HermesInstallReport {
  steps: StepResult[];
  ok: boolean;
}

/** Resolve packaged scripts dir (npm) or monorepo dev path. */
export function resolveHermesScriptsDir(): string {
  try {
    const packaged = path.join(path.dirname(require.resolve('tim-hooks/package.json') as string), 'scripts');
    if (fs.existsSync(path.join(packaged, CACHE_HOOK))) return packaged;
  } catch {
    /* not installed via npm layout */
  }
  const dev = path.resolve(__dirname, '../../tim-hooks/scripts');
  if (fs.existsSync(path.join(dev, CACHE_HOOK))) return dev;
  throw new Error('TIM Hermes scripts not found. Run from TIM repo or reinstall tim-cli/tim-hooks.');
}

export function ensureCacheHookInConfig(yaml: string): { yaml: string; changed: boolean } {
  if (yaml.includes(CACHE_HOOK)) return { yaml, changed: false };

  const hookBlock = `  - command: ~/.hermes/agent-hooks/${CACHE_HOOK}\n    timeout: 10\n`;
  const afterStartup = /(- command:.*o9k-startup\.sh[^\n]*\n(?:    timeout: [^\n]+\n)?)/;
  const preHeader = /(hooks:\s*\n\s*pre_llm_call:\s*\n)/;
  const m = yaml.match(afterStartup) ?? yaml.match(preHeader);
  if (m?.index === undefined) throw new Error('Could not find hooks.pre_llm_call in ~/.hermes/config.yaml');
  const insertAt = m.index + m[0].length;
  return { yaml: yaml.slice(0, insertAt) + hookBlock + yaml.slice(insertAt), changed: true };
}

export async function installHermesHooks(
  opts: { dryRun?: boolean; hooksDir?: string; configPath?: string } = {},
): Promise<HermesInstallReport> {
  const steps: StepResult[] = [];
  const dryRun = opts.dryRun ?? false;
  const hooksDir = opts.hooksDir ?? path.join(os.homedir(), '.hermes', 'agent-hooks');
  const configPath = opts.configPath ?? path.join(os.homedir(), '.hermes', 'config.yaml');
  const fail = (step: string, detail: string) => {
    steps.push({ step, status: 'fail', detail });
    return { steps, ok: false };
  };

  let src: string;
  try {
    src = path.join(resolveHermesScriptsDir(), CACHE_HOOK);
  } catch (e) {
    return fail('scripts', (e as Error).message);
  }

  const dest = path.join(hooksDir, CACHE_HOOK);
  let linked = false;
  try {
    linked = fs.realpathSync(dest) === fs.realpathSync(src);
  } catch {
    /* missing or broken link */
  }
  if (linked) {
    steps.push({ step: `symlink:${CACHE_HOOK}`, status: 'skip', detail: `already linked → ${dest}` });
  } else if (dryRun) {
    steps.push({ step: `symlink:${CACHE_HOOK}`, status: 'ok', detail: `would link → ${dest}` });
  } else {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.rmSync(dest, { force: true });
    fs.chmodSync(src, 0o755);
    fs.symlinkSync(src, dest);
    steps.push({ step: `symlink:${CACHE_HOOK}`, status: 'ok', detail: `linked → ${dest}` });
  }

  if (!fs.existsSync(configPath)) return fail('config.yaml', `not found: ${configPath}`);
  try {
    const { yaml, changed } = ensureCacheHookInConfig(fs.readFileSync(configPath, 'utf8'));
    if (!changed) {
      steps.push({ step: 'config.yaml', status: 'skip', detail: `${CACHE_HOOK} already registered` });
    } else if (dryRun) {
      steps.push({ step: 'config.yaml', status: 'ok', detail: `would insert ${CACHE_HOOK} under pre_llm_call` });
    } else {
      const backup = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(configPath, backup);
      fs.writeFileSync(configPath, yaml);
      steps.push({ step: 'config.yaml', status: 'ok', detail: `added ${CACHE_HOOK} (backup: ${backup})` });
    }
  } catch (e) {
    return fail('config.yaml', (e as Error).message);
  }
  return { steps, ok: true };
}
