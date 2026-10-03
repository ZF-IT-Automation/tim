import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isShippedSessionStartScript, isTimHookCommand, timHookCommand } from './claude-hooks-install.js';

/**
 * cursor-agent 2026.08 has a real turn-end hook (`stop`) — but only in the
 * interactive TUI. Under `cursor-agent -p` no `stop`, `beforeSubmitPrompt` or
 * `afterAgentResponse` fires at all; the only turn-end signal there is
 * `sessionEnd`, which the process emits per invocation. So both are registered
 * with the same command and the exchange dedupe absorbs the double fire when a
 * TUI session ends. Cursor's hooks.json is flat — event name to command list —
 * and other tooling (hmem, o9k) owns entries in it, so nothing here overwrites.
 *
 * `hook cursor-stop` also checkpoints the session when the payload's
 * `hook_event_name` is `sessionEnd` — Cursor's equivalent of Claude's SessionEnd.
 * That is why no separate session-end entry is registered: one command keeps the
 * checkpoint ordered after the exchange it summarizes.
 */

export interface CursorInstallStep {
  step: 'session-start-hook' | 'turn-end-hooks';
  status: 'installed' | 'unchanged' | 'skip';
  path: string;
  detail?: string;
}

export interface CursorHooksInstallResult {
  ok: boolean;
  steps: CursorInstallStep[];
  notes: string[];
}

/** Cursor fires the turn-end hook per turn in the TUI, once per run under -p. */
export const TURN_END_EVENTS = ['stop', 'sessionEnd'] as const;

interface CursorHookCommand {
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookCommand[]>;
  [key: string]: unknown;
}

export function cursorHome(): string {
  return path.join(os.homedir(), '.cursor');
}

/** Cursor is present if it left a home behind or is on PATH. */
export function detectCursor(home = cursorHome()): boolean {
  if (fs.existsSync(home)) return true;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some(dir => fs.existsSync(path.join(dir, 'cursor-agent')));
}

function timCliPath(): string {
  return path.resolve(__dirname, 'cli.js');
}

/**
 * Absolute node, like the Codex installer writes: hooks spawn without a login
 * shell, so a version-managed node is not on the PATH they inherit.
 */
export function cursorStopCommand(cli = timCliPath(), node = process.execPath): string {
  return timHookCommand('cursor-stop', cli, node);
}

function writeAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, filePath);
}

function hasCommand(entries: CursorHookCommand[], needles: string[]): boolean {
  return entries.some(entry =>
    typeof entry.command === 'string' && needles.some(needle => entry.command.includes(needle)));
}

/**
 * An older TIM entry (`isOurs`) is rewritten in place — paths move with the
 * checkout or node — and anything else matching a needle counts as present.
 */
function withHook(
  file: CursorHooksFile,
  event: string,
  command: string,
  needles: string[],
  timeout: number,
  isOurs: (command: string) => boolean = () => false,
): CursorHooksFile {
  const original = file.hooks?.[event] ?? [];
  const entries = original.map(entry =>
    typeof entry.command === 'string' && entry.command !== command && isOurs(entry.command)
      ? { ...entry, command }
      : entry);
  if (entries.some((entry, i) => entry !== original[i])) {
    file = { ...file, hooks: { ...file.hooks, [event]: entries } };
  }
  if (hasCommand(entries, needles)) return file;
  return {
    ...file,
    version: file.version ?? 1,
    hooks: { ...file.hooks, [event]: [...entries, { command, timeout }] },
  };
}

/**
 * The checkout's own tim-session-start.sh (what older installs wrote) is rewritten
 * to the node command; a hand-placed copy elsewhere is reused as it is.
 */
export function mergeCursorSessionStart(file: CursorHooksFile, command: string): CursorHooksFile {
  return withHook(file, 'sessionStart', command, ['tim-session-start', 'hook agent-session-start'], 10,
    c => isShippedSessionStartScript(c) || isTimHookCommand(c, 'agent-session-start'));
}

export function mergeCursorTurnEnd(file: CursorHooksFile, command: string): CursorHooksFile {
  let next = file;
  for (const event of TURN_END_EVENTS) {
    next = withHook(next, event, command, ['hook cursor-stop'], 10, c => isTimHookCommand(c, 'cursor-stop'));
  }
  return next;
}

function readHooksFile(hooksPath: string): CursorHooksFile | string {
  if (!fs.existsSync(hooksPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'hooks.json is not a JSON object';
    }
    return parsed as CursorHooksFile;
  } catch {
    return 'hooks.json is invalid JSON';
  }
}

function applyMerge(
  step: CursorInstallStep['step'],
  hooksPath: string,
  merge: (file: CursorHooksFile) => CursorHooksFile,
): CursorInstallStep {
  const existing = readHooksFile(hooksPath);
  if (typeof existing === 'string') {
    return { step, status: 'skip', path: hooksPath, detail: existing };
  }

  const next = merge(existing);
  if (JSON.stringify(next) === JSON.stringify(existing)) {
    return { step, status: 'unchanged', path: hooksPath };
  }

  if (fs.existsSync(hooksPath)) fs.copyFileSync(hooksPath, `${hooksPath}.backup.${Date.now()}`);
  writeAtomic(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  return { step, status: 'installed', path: hooksPath };
}

export function installCursorSessionStartHook(
  options: { hooksPath?: string; cli?: string } = {},
): CursorInstallStep {
  const hooksPath = options.hooksPath ?? path.join(cursorHome(), 'hooks.json');
  const command = timHookCommand('agent-session-start', options.cli ?? timCliPath());
  return applyMerge('session-start-hook', hooksPath, file => mergeCursorSessionStart(file, command));
}

export function installCursorTurnEndHooks(
  options: { hooksPath?: string; cli?: string } = {},
): CursorInstallStep {
  const hooksPath = options.hooksPath ?? path.join(cursorHome(), 'hooks.json');
  const command = cursorStopCommand(options.cli ?? timCliPath());
  return applyMerge('turn-end-hooks', hooksPath, file => mergeCursorTurnEnd(file, command));
}

export function installCursorHooks(
  options: { hooksPath?: string; cli?: string } = {},
): CursorHooksInstallResult {
  // Sequential: both steps write the same file, so the second must read the first.
  const steps = [
    installCursorTurnEndHooks({ hooksPath: options.hooksPath, cli: options.cli }),
    installCursorSessionStartHook({ hooksPath: options.hooksPath, cli: options.cli }),
  ];
  return {
    ok: steps.every(step => step.status !== 'skip'),
    steps,
    notes: [
      'Restart any running cursor-agent session to pick the hooks up.',
      'Exchanges are logged per turn in the interactive TUI and once per run under ' +
        '`cursor-agent -p`, which fires no turn-end hook of its own.',
    ],
  };
}
