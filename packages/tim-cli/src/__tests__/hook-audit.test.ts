import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditTimHooks } from '../hook-audit.js';

describe('auditTimHooks', () => {
  let home: string;
  let originalPath: string | undefined;
  let live: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-hook-audit-'));
    originalPath = process.env.PATH;
    process.env.PATH = path.join(home, 'empty-bin');
    delete process.env.CODEX_HOME;
    const cli = path.join(home, 'my tim', 'packages', 'tim-cli', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
    live = `'${process.execPath}' '${cli}' hook`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function write(rel: string, value: unknown): void {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }

  it('flags missing paths and bare tim, passes runnable hooks, ignores foreign ones', () => {
    write('.claude/settings.json', { hooks: {
      SessionStart: [{ matcher: '', hooks: [
        { type: 'command', command: `${live} claude-session-start` },
        { type: 'command', command: 'bash /home/x/.claude/hooks/agent-role.sh' },
      ] }],
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'tim hook prompt-submit' }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: "'/gone/node' '/gone/tim-cli/dist/cli.js' hook claude-stop" }] }],
    } });
    write('.codex/config.toml', `notify = ["/gone/node", "/gone/cli.js", "hook", "codex-notify"]\nmodel = "x"\n`);
    write('.cursor/hooks.json', { version: 1, hooks: { stop: [{ command: `${live} cursor-stop` }] } });

    const byEvent = Object.fromEntries(auditTimHooks(home).map(f => [`${f.host}:${f.event}`, f]));
    expect(Object.keys(byEvent).sort()).toEqual([
      'claude:SessionStart', 'claude:Stop', 'claude:UserPromptSubmit', 'codex:notify', 'cursor:stop',
    ]);
    expect(byEvent['claude:SessionStart']!.problem).toBeNull();
    expect(byEvent['claude:UserPromptSubmit']).toMatchObject({ problem: '`tim` is not on PATH', fragile: true });
    expect(byEvent['claude:Stop']!.problem).toBe('/gone/node does not exist');
    expect(byEvent['codex:notify']!.problem).toBe('/gone/node does not exist');
    expect(byEvent['cursor:stop']!.problem).toBeNull();
  });

  it('reports nothing when no host is configured', () => {
    expect(auditTimHooks(home)).toEqual([]);
  });
});
