import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cursorStopCommand,
  installCursorSessionStartHook,
  installCursorTurnEndHooks,
} from '../cursor-hooks-install.js';

interface HooksFile {
  version?: number;
  hooks?: Record<string, { command: string; timeout?: number }[]>;
}

describe('cursor hooks install', () => {
  let root: string;
  let hooksPath: string;
  const cli = '/opt/tim/cli.js';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-cursor-install-'));
    hooksPath = path.join(root, 'hooks.json');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function read(): HooksFile {
    return JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as HooksFile;
  }

  it('spells out an absolute node, not a PATH lookup', () => {
    expect(cursorStopCommand(cli)).toContain(process.execPath);
    expect(cursorStopCommand(cli)).not.toMatch(/^node /);
  });

  it('registers the turn-end command on both stop and sessionEnd, once', () => {
    expect(installCursorTurnEndHooks({ hooksPath, cli })).toMatchObject({ status: 'installed' });
    expect(installCursorTurnEndHooks({ hooksPath, cli })).toMatchObject({ status: 'unchanged' });

    const file = read();
    expect(file.hooks?.stop).toHaveLength(1);
    expect(file.hooks?.sessionEnd).toHaveLength(1);
    expect(file.hooks?.stop?.[0]?.command).toContain('hook cursor-stop');
  });

  it('keeps entries other tools own', () => {
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: './hooks/hmem-log-exchange.sh', timeout: 15 }],
        sessionStart: [{ command: 'bash /home/x/.cursor/hooks/o9k-core-session.sh', timeout: 15 }],
      },
    }));

    installCursorTurnEndHooks({ hooksPath, cli });

    const file = read();
    expect(file.hooks?.stop?.map(h => h.command)).toEqual([
      './hooks/hmem-log-exchange.sh',
      cursorStopCommand(cli),
    ]);
    expect(file.hooks?.sessionStart).toHaveLength(1);
  });

  it('recognizes a hand-placed session-start hook instead of adding a second one', () => {
    const script = path.join(root, 'tim-session-start.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\n');
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: 'bash /home/x/.cursor/hooks/tim-session-start.sh', timeout: 10 }] },
    }));

    expect(installCursorSessionStartHook({ hooksPath, script })).toMatchObject({ status: 'unchanged' });
    expect(read().hooks?.sessionStart).toHaveLength(1);
  });

  it('refuses a hooks.json it cannot parse rather than overwriting it', () => {
    fs.writeFileSync(hooksPath, '{ not json');
    expect(installCursorTurnEndHooks({ hooksPath, cli })).toMatchObject({ status: 'skip' });
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe('{ not json');
  });

  it('backs the file up before changing it', () => {
    fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: {} }));
    installCursorTurnEndHooks({ hooksPath, cli });
    const backups = fs.readdirSync(root).filter(name => name.includes('.backup.'));
    expect(backups).toHaveLength(1);
  });
});
