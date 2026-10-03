import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isShippedSessionStartScript } from './claude-hooks-install.js';
import { resolveOnPath } from './summarizer-health.js';

export interface HookFinding {
  host: 'claude' | 'codex' | 'cursor';
  event: string;
  command: string;
  /** null = runnable as far as files and PATH can tell. */
  problem: string | null;
  /** Runs today but breaks as soon as the host's PATH differs from this shell's. */
  fragile: boolean;
}

const TIM_HOOK_RE = /(?:^|[\s'"/])(?:tim|cli\.js)['"]?\s+hook\s+[a-z-]+|tim-session-start\.sh/;

/** Absolute paths a command names, quoted or not. */
function absolutePaths(command: string): string[] {
  const tokens = command.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  return tokens.map(t => t.replace(/^['"]|['"]$/g, '')).filter(t => t.startsWith('/'));
}

/**
 * Read-only: can each TIM hook a host has configured actually start? A dead hook
 * fails silently inside the host, so doctor is the only place it shows up.
 */
export function problemFor(command: string): string | null {
  const missing = absolutePaths(command).find(p => !fs.existsSync(p));
  if (missing) return `${missing} does not exist`;
  if (/^\s*tim\s/.test(command) && !resolveOnPath('tim')) return '`tim` is not on PATH';
  if (isShippedSessionStartScript(command) && !resolveOnPath('jq')) return 'tim-session-start.sh needs jq, which is not on PATH';
  return null;
}

function finding(host: HookFinding['host'], event: string, command: string): HookFinding {
  return { host, event, command, problem: problemFor(command), fragile: /^\s*tim\s/.test(command) };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type Groups = Record<string, { hooks?: { command?: unknown }[]; command?: unknown }[]>;

function scan(host: HookFinding['host'], hooks: Groups | undefined, out: HookFinding[]): void {
  for (const [event, items] of Object.entries(hooks ?? {})) {
    for (const item of items ?? []) {
      // Claude/Codex nest commands in matcher groups; Cursor lists them flat.
      for (const hook of item.hooks ?? [item]) {
        const command = typeof hook.command === 'string' ? hook.command : '';
        if (TIM_HOOK_RE.test(command)) out.push(finding(host, event, command));
      }
    }
  }
}

export function auditTimHooks(home = os.homedir()): HookFinding[] {
  const out: HookFinding[] = [];
  scan('claude', readJson(path.join(home, '.claude', 'settings.json'))?.hooks as Groups, out);
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  scan('codex', readJson(path.join(codexHome, 'hooks.json'))?.hooks as Groups, out);
  try {
    const notify = /^[ \t]*notify[ \t]*=[ \t]*(\[.*\])/m.exec(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    const argv = notify ? JSON.parse(notify[1]!) as string[] : [];
    if (argv.includes('codex-notify')) {
      const command = argv.map(a => `'${a}'`).join(' ');
      out.push(finding('codex', 'notify', command));
    }
  } catch {
    // no config.toml, or a notify TIM did not write
  }
  scan('cursor', readJson(path.join(home, '.cursor', 'hooks.json'))?.hooks as Groups, out);
  return out;
}
