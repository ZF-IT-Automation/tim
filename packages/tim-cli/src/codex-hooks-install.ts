import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isShippedSessionStartScript, isTimHookCommand, timHookCommand } from './claude-hooks-install.js';

/**
 * Codex 0.147 has no turn-end hook event, and the hooks it does have are
 * skipped until the user grants them persisted trust. So exchange logging goes
 * through `notify` in config.toml — a turn-end callback that needs no trust —
 * and the session-start briefing goes through hooks.json, which will stay inert
 * until trusted. Both files have other owners (o9k), so nothing here overwrites.
 */

export interface CodexInstallStep {
  step: 'notify' | 'session-start-hook';
  status: 'installed' | 'unchanged' | 'skip';
  path: string;
  detail?: string;
}

export interface CodexHooksInstallResult {
  ok: boolean;
  steps: CodexInstallStep[];
  notes: string[];
}

const NOTIFY_LINE_RE = /^[ \t]*notify[ \t]*=/m;
const TIM_NOTIFY_MARKER = 'hook", "codex-notify"';

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Codex is present if it left a home behind or is on PATH. */
export function detectCodex(home = codexHome()): boolean {
  if (fs.existsSync(home)) return true;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some(dir => fs.existsSync(path.join(dir, 'codex')));
}

function timCliPath(): string {
  return path.resolve(__dirname, 'cli.js');
}

/**
 * Absolute node, like the MCP installer writes: `notify` spawns without a login
 * shell, so a version-managed node is not on the PATH it inherits.
 */
export function codexNotifyLine(cli = timCliPath(), node = process.execPath): string {
  return `notify = [${JSON.stringify(node)}, ${JSON.stringify(cli)}, "hook", "codex-notify"]`;
}

function writeAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * `notify` is a single top-level key, so it must go above the first `[table]`
 * header — appending at EOF would bury it inside whatever section ends the file.
 */
export function mergeCodexNotify(existing: string, line: string): string {
  return existing.trim() ? `${line}\n${existing}` : `${line}\n`;
}

export function installCodexNotify(
  options: { configPath?: string; cli?: string } = {},
): CodexInstallStep {
  const configPath = options.configPath ?? path.join(codexHome(), 'config.toml');
  const line = codexNotifyLine(options.cli ?? timCliPath());
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';

  const current = NOTIFY_LINE_RE.exec(existing);
  if (current) {
    const claimed = existing.slice(current.index).split('\n')[0] ?? '';
    if (!claimed.includes(TIM_NOTIFY_MARKER)) {
      return {
        step: 'notify',
        status: 'skip',
        path: configPath,
        detail: `notify already claimed by another owner — left alone: ${claimed.trim()}`,
      };
    }
    if (claimed.trim() === line) return { step: 'notify', status: 'unchanged', path: configPath };
    // TIM's own line with an old node or checkout path: repoint it in place.
    fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
    const at = current.index;
    writeAtomic(configPath, existing.slice(0, at) + line + existing.slice(at + claimed.length));
    return { step: 'notify', status: 'installed', path: configPath };
  }

  if (existing) fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
  writeAtomic(configPath, mergeCodexNotify(existing, line));
  return { step: 'notify', status: 'installed', path: configPath };
}

interface CodexHookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface CodexMatcherGroup {
  matcher?: string;
  hooks: CodexHookCommand[];
}

interface CodexHooksFile {
  hooks?: Record<string, CodexMatcherGroup[]>;
  [key: string]: unknown;
}

/**
 * The entry may already be there under a hand-placed path, so match on the
 * script name rather than the exact command string — an exact match would
 * install a second session-start hook next to the existing one.
 */
export function mergeCodexSessionStart(file: CodexHooksFile, command: string): CodexHooksFile {
  // Older TIM entries — the checkout's own script, or a node command whose paths
  // moved — are rewritten in place; a hand-placed script elsewhere stays.
  const original = file.hooks?.SessionStart ?? [];
  let changed = false;
  const isTim = (c: string) => isShippedSessionStartScript(c)
    || isTimHookCommand(c, 'agent-session-start') || isTimHookCommand(c, 'claude-session-start');
  const groups = original.map(group => ({
    ...group,
    hooks: group.hooks.map(hook => {
      if (!isTim(hook.command) || hook.command === command) return hook;
      changed = true;
      return { ...hook, command };
    }),
  }));
  if (changed) file = { ...file, hooks: { ...file.hooks, SessionStart: groups } };
  const alreadyThere = groups.some(group =>
    group.hooks.some(hook => ['tim-session-start', 'hook claude-session-start', 'hook agent-session-start']
      .some(needle => hook.command.includes(needle))),
  );
  if (alreadyThere) return file;

  return {
    ...file,
    hooks: {
      ...file.hooks,
      SessionStart: [
        ...groups,
        { matcher: 'startup|resume', hooks: [{ type: 'command', command, timeout: 10 }] },
      ],
    },
  };
}

export function installCodexSessionStartHook(
  options: { hooksPath?: string; cli?: string } = {},
): CodexInstallStep {
  const hooksPath = options.hooksPath ?? path.join(codexHome(), 'hooks.json');

  let existing: CodexHooksFile = {};
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { step: 'session-start-hook', status: 'skip', path: hooksPath, detail: 'hooks.json is not a JSON object' };
      }
      existing = parsed as CodexHooksFile;
    } catch {
      return { step: 'session-start-hook', status: 'skip', path: hooksPath, detail: 'hooks.json is invalid JSON' };
    }
  }

  const next = mergeCodexSessionStart(existing, timHookCommand('agent-session-start', options.cli ?? timCliPath()));
  if (JSON.stringify(next) === JSON.stringify(existing)) {
    return { step: 'session-start-hook', status: 'unchanged', path: hooksPath };
  }

  if (fs.existsSync(hooksPath)) fs.copyFileSync(hooksPath, `${hooksPath}.backup.${Date.now()}`);
  writeAtomic(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  return { step: 'session-start-hook', status: 'installed', path: hooksPath };
}

export function installCodexHooks(
  options: { configPath?: string; hooksPath?: string; cli?: string } = {},
): CodexHooksInstallResult {
  const steps = [
    installCodexNotify({ configPath: options.configPath, cli: options.cli }),
    installCodexSessionStartHook({ hooksPath: options.hooksPath, cli: options.cli }),
  ];
  return {
    ok: steps.every(step => step.status !== 'skip'),
    steps,
    notes: [
      'notify logs exchanges and works immediately — restart any running Codex session to pick it up.',
      'Codex skips hooks.json entries until they are trusted: run `codex` once and approve the hook, ' +
        'or start it with --dangerously-bypass-hook-trust. Until then the session-start briefing stays silent.',
    ],
  };
}
