import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeHookCommand {
  type: string;
  command: string;
  timeout?: number;
}

export interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookCommand[];
}

export interface ClaudeSettings {
  permissions?: Record<string, unknown>;
  hooks?: {
    SessionStart?: ClaudeHookMatcher[];
    UserPromptSubmit?: ClaudeHookMatcher[];
    Stop?: ClaudeHookMatcher[];
    SessionEnd?: ClaudeHookMatcher[];
    [event: string]: ClaudeHookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

export interface ClaudeHooksInstallResult {
  status: 'installed' | 'unchanged' | 'skipped';
  settingsPath: string;
  backupPath?: string;
  reason?: string;
}

interface TimClaudeHook {
  event: 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd';
  sub: string;
  timeout: number;
  /** Older hand-placed scripts that already do this hook's job. Kept as they are. */
  equivalents?: string[];
}

const TIM_HOOKS: TimClaudeHook[] = [
  // Roomier timeout than prompt-submit: this one reads the store to assemble the
  // briefing, and a missing briefing costs the whole session its context.
  { event: 'SessionStart', sub: 'claude-session-start', timeout: 10, equivalents: ['tim-session-start'] },
  { event: 'UserPromptSubmit', sub: 'prompt-submit', timeout: 2 },
  { event: 'Stop', sub: 'claude-stop', timeout: 5 },
  // Ends the session TIM would otherwise never see closed: /clear and exit both
  // fire this, and the checkpoint is the last thing written before the id is gone.
  { event: 'SessionEnd', sub: 'claude-session-end', timeout: 10 },
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Absolute node and cli.js, like the Codex and Cursor installers write. A bare
 * `tim` needs the CLI linked onto PATH and node on the PATH the host hands its
 * hooks — neither holds after a plain source install, and the hook then fails
 * with 127 on every prompt without anyone seeing it.
 */
export function timHookCommand(
  sub: string,
  cli = path.resolve(__dirname, 'cli.js'),
  node = process.execPath,
): string {
  return `${shellQuote(node)} ${shellQuote(cli)} hook ${sub}`;
}

/**
 * The session-start script older installers pointed hooks at, inside a checkout.
 * A hook naming it breaks when the checkout moves and needs jq, so it is
 * rewritten like any other older TIM command. Copies placed elsewhere by hand
 * (say ~/.claude/hooks/tim-session-start.sh) are someone's choice and stay.
 */
export function isShippedSessionStartScript(command: string): boolean {
  return /tim-hooks\/scripts\/tim-session-start\.sh/.test(command);
}

/** Any earlier TIM form of this hook: bare `tim`, a linked `.../tim`, or `.../tim-cli/dist/cli.js`. */
export function isTimHookCommand(command: string, sub: string): boolean {
  return new RegExp(`(?:^|[\\s'"])(?:[^\\s'"]*/)?(?:tim|tim-cli/(?:dist|src)/cli\\.js)['"]?\\s+hook\\s+${sub}(?:\\s|$)`).test(command);
}

/**
 * Per hook entry, never per matcher group: TIM's hook often shares a group with
 * other tools' hooks, and the group's matcher belongs to whoever set it. An older
 * TIM command is rewritten in place, so a rerun after moving the checkout or
 * upgrading node repairs the paths instead of adding a second hook.
 */
export function mergeClaudeHooks(
  settings: ClaudeSettings,
  commandFor: (sub: string) => string = timHookCommand,
): ClaudeSettings {
  const hooks: NonNullable<ClaudeSettings['hooks']> = { ...settings.hooks };
  for (const spec of TIM_HOOKS) {
    const command = commandFor(spec.sub);
    let found = false;
    const groups = (hooks[spec.event] ?? []).map(group => ({
      ...group,
      hooks: group.hooks.map(hook => {
        if (typeof hook.command !== 'string') return hook;
        const shipped = spec.equivalents !== undefined && isShippedSessionStartScript(hook.command);
        if (!shipped && spec.equivalents?.some(name => hook.command.includes(name))) {
          found = true;
          return hook;
        }
        if (!shipped && !isTimHookCommand(hook.command, spec.sub)) return hook;
        found = true;
        return hook.command === command ? hook : { ...hook, command };
      }),
    }));
    hooks[spec.event] = found
      ? groups
      : [...groups, { matcher: '', hooks: [{ type: 'command', command, timeout: spec.timeout }] }];
  }
  return { ...settings, hooks };
}

function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function writeAtomicJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.settings.json.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function installClaudeHooks(
  options: { settingsPath?: string } = {},
): ClaudeHooksInstallResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  let existing: ClaudeSettings = {};

  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          status: 'skipped',
          settingsPath,
          reason: 'settings.json is not a JSON object',
        };
      }
      existing = parsed as ClaudeSettings;
    } catch {
      return {
        status: 'skipped',
        settingsPath,
        reason: 'settings.json is invalid JSON',
      };
    }
  }

  const next = mergeClaudeHooks(existing);
  if (JSON.stringify(next) === JSON.stringify(existing)) {
    return { status: 'unchanged', settingsPath };
  }

  let backupPath: string | undefined;
  if (fs.existsSync(settingsPath)) {
    backupPath = `${settingsPath}.backup.${Date.now()}`;
    fs.copyFileSync(settingsPath, backupPath);
  }

  writeAtomicJson(settingsPath, next);
  return { status: 'installed', settingsPath, backupPath };
}
