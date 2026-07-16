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
    UserPromptSubmit?: ClaudeHookMatcher[];
    Stop?: ClaudeHookMatcher[];
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

const TIM_PROMPT: ClaudeHookMatcher = {
  matcher: '',
  hooks: [{ type: 'command', command: 'tim hook prompt-submit', timeout: 2 }],
};

const TIM_STOP: ClaudeHookMatcher = {
  matcher: '',
  hooks: [{ type: 'command', command: 'tim hook claude-stop', timeout: 5 }],
};

function appendUnique(
  existing: ClaudeHookMatcher[] | undefined,
  value: ClaudeHookMatcher,
): ClaudeHookMatcher[] {
  const items = existing ?? [];
  const command = value.hooks[0]?.command;
  return items.some(item => item.hooks.some(hook => hook.command === command))
    ? items
    : [...items, value];
}

export function mergeClaudeHooks(settings: ClaudeSettings): ClaudeSettings {
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      UserPromptSubmit: appendUnique(settings.hooks?.UserPromptSubmit, TIM_PROMPT),
      Stop: appendUnique(settings.hooks?.Stop, TIM_STOP),
    },
  };
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
