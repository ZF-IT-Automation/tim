import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installClaudeHooks,
  mergeClaudeHooks,
  type ClaudeSettings,
} from '../claude-hooks-install.js';

describe('mergeClaudeHooks', () => {
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
