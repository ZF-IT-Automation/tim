import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeHookCommand,
  installClaudeHooks,
  mergeClaudeHooks,
  type ClaudeSettings,
} from '../claude-hooks-install.js';

describe('mergeClaudeHooks', () => {
  it('installs the SessionStart briefing hook through absolute node and cli.js', () => {
    const next = mergeClaudeHooks({});
    const sessionStart = next.hooks?.SessionStart;
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart?.[0].hooks[0]).toEqual({
      type: 'command',
      command: claudeHookCommand('claude-session-start'),
      timeout: 10,
    });
    expect(claudeHookCommand('claude-stop', '/a b/cli.js', "/n'ode")).toBe(
      `'/n'\\''ode' '/a b/cli.js' hook claude-stop`,
    );
    expect(claudeHookCommand('prompt-submit')).toMatch(/^'\/.+' '\/.+tim-cli\/(dist|src)\/cli\.js' hook prompt-submit$/);
  });

  it('rewrites older TIM commands in place and keeps shared groups and matchers', () => {
    const existing: ClaudeSettings = {
      hooks: {
        SessionStart: [{
          matcher: 'startup|clear|compact',
          hooks: [
            { type: 'command', command: 'bash /old/tim/packages/tim-hooks/scripts/tim-session-start.sh', timeout: 10 },
            { type: 'command', command: 'bash /home/u/.claude/hooks/agent-role.sh', timeout: 5 },
          ],
        }],
        UserPromptSubmit: [{
          matcher: '',
          hooks: [
            { type: 'command', command: 'tim hook prompt-submit', timeout: 2 },
            { type: 'command', command: 'node /x/other/cli.js hook prompt-submit', timeout: 5 },
          ],
        }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: "'/old/node' '/old/tim/packages/tim-cli/dist/cli.js' hook claude-stop", timeout: 5 }] }],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: '/home/u/.local/bin/tim hook claude-session-end', timeout: 10 }] }],
      },
    };
    const next = mergeClaudeHooks(existing);

    // The hand-placed session-start script already briefs: kept, nothing added.
    expect(next.hooks?.SessionStart).toEqual(existing.hooks?.SessionStart);
    expect(next.hooks?.UserPromptSubmit).toEqual([{
      matcher: '',
      hooks: [
        { type: 'command', command: claudeHookCommand('prompt-submit'), timeout: 2 },
        { type: 'command', command: 'node /x/other/cli.js hook prompt-submit', timeout: 5 },
      ],
    }]);
    expect(next.hooks?.Stop).toEqual([{ matcher: '', hooks: [{ type: 'command', command: claudeHookCommand('claude-stop'), timeout: 5 }] }]);
    expect(next.hooks?.SessionEnd?.[0].hooks).toEqual([{ type: 'command', command: claudeHookCommand('claude-session-end'), timeout: 10 }]);
    expect(mergeClaudeHooks(next)).toEqual(next);
  });

  it('does not duplicate the SessionStart hook and keeps foreign ones', () => {
    const existing: ClaudeSettings = {
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo other-start' }] },
        ],
      },
    };
    const once = mergeClaudeHooks(existing);
    expect(once.hooks?.SessionStart).toHaveLength(2);
    expect(once.hooks?.SessionStart?.[0].hooks[0].command).toBe('echo other-start');
    expect(mergeClaudeHooks(once)).toEqual(once);
  });

  it('appends TIM prompt-submit and Stop hooks once while preserving unrelated settings', () => {
    const existing: ClaudeSettings = {
      permissions: { allow: ['Bash(*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        UserPromptSubmit: [
          { matcher: 'custom', hooks: [{ type: 'command', command: 'echo custom-prompt' }] },
        ],
      },
    };

    const next = mergeClaudeHooks(existing);

    expect(next.permissions).toEqual(existing.permissions);
    expect(next.hooks?.PreToolUse).toEqual(existing.hooks?.PreToolUse);
    expect(next.hooks?.UserPromptSubmit).toContainEqual(
      expect.objectContaining({
        hooks: expect.arrayContaining([
          expect.objectContaining({ command: expect.stringContaining('hook prompt-submit') }),
        ]),
      }),
    );
    expect(next.hooks?.Stop).toContainEqual(
      expect.objectContaining({
        hooks: expect.arrayContaining([
          expect.objectContaining({ command: expect.stringContaining('hook claude-stop') }),
        ]),
      }),
    );
    expect(next.hooks?.UserPromptSubmit).toContainEqual(
      expect.objectContaining({
        hooks: expect.arrayContaining([
          expect.objectContaining({ command: 'echo custom-prompt' }),
        ]),
      }),
    );
    expect(mergeClaudeHooks(next)).toEqual(next);
  });

  it('installs the SessionEnd checkpoint hook once', () => {
    const next = mergeClaudeHooks({});
    expect(next.hooks?.SessionEnd?.[0].hooks[0]).toEqual({
      type: 'command',
      command: claudeHookCommand('claude-session-end'),
      timeout: 10,
    });
    expect(mergeClaudeHooks(next).hooks?.SessionEnd).toHaveLength(1);
  });
});

describe('installClaudeHooks', () => {
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-claude-hooks-install-'));
    settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes atomically, backs up valid JSON, and is idempotent', () => {
    const existing: ClaudeSettings = {
      permissions: { deny: ['WebFetch'] },
      hooks: {
        Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    const first = installClaudeHooks({ settingsPath });
    expect(first.status).toBe('installed');
    expect(first.backupPath).toBeTruthy();
    expect(fs.existsSync(first.backupPath!)).toBe(true);

    const afterFirst = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
    expect(afterFirst.permissions).toEqual(existing.permissions);
    expect(afterFirst.hooks?.Notification).toEqual(existing.hooks?.Notification);
    expect(afterFirst.hooks?.SessionStart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hooks: expect.arrayContaining([
            expect.objectContaining({ command: claudeHookCommand('claude-session-start') }),
          ]),
        }),
      ]),
    );
    expect(afterFirst.hooks?.UserPromptSubmit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hooks: expect.arrayContaining([
            expect.objectContaining({ command: expect.stringContaining('hook prompt-submit') }),
          ]),
        }),
      ]),
    );

    const second = installClaudeHooks({ settingsPath });
    expect(second.status).toBe('unchanged');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(afterFirst);
  });

  it('skips invalid JSON without mutating the file', () => {
    fs.writeFileSync(settingsPath, '{not-json');
    const before = fs.readFileSync(settingsPath, 'utf8');
    const result = installClaudeHooks({ settingsPath });
    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});
