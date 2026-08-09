import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codexNotifyLine,
  installCodexNotify,
  installCodexSessionStartHook,
  mergeCodexNotify,
  mergeCodexSessionStart,
} from '../codex-hooks-install.js';

describe('codex notify install', () => {
  let root: string;
  let configPath: string;
  const cli = '/opt/tim/cli.js';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-codex-install-'));
    configPath = path.join(root, 'config.toml');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('spells out an absolute node, not a PATH lookup', () => {
    expect(codexNotifyLine(cli)).toContain(JSON.stringify(process.execPath));
    expect(codexNotifyLine(cli)).not.toMatch(/\["node"/);
  });

  it('puts notify above the first table so it stays a top-level key', () => {
    const existing = 'model = "gpt-5.6-sol"\n\n[projects."/home/x"]\ntrust_level = "trusted"\n';
    const merged = mergeCodexNotify(existing, codexNotifyLine(cli));
    expect(merged.split('\n')[0]).toContain('notify = ');
    expect(merged.indexOf('notify = ')).toBeLessThan(merged.indexOf('[projects.'));
  });

  it('installs once and reports unchanged on re-run', () => {
    fs.writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    expect(installCodexNotify({ configPath, cli })).toMatchObject({ status: 'installed' });
    expect(installCodexNotify({ configPath, cli })).toMatchObject({ status: 'unchanged' });
    expect(fs.readFileSync(configPath, 'utf8').match(/notify = /g)).toHaveLength(1);
  });

  it('leaves a notify claimed by another owner alone', () => {
    fs.writeFileSync(configPath, 'notify = ["/usr/bin/o9k-notify"]\nmodel = "x"\n');
    const step = installCodexNotify({ configPath, cli });
    expect(step.status).toBe('skip');
    expect(step.detail).toContain('o9k-notify');
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('codex-notify');
  });
});

describe('codex session-start hook merge', () => {
  let root: string;
  let hooksPath: string;
  let script: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-codex-hooks-'));
    hooksPath = path.join(root, 'hooks.json');
    script = path.join(root, 'tim-session-start.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps foreign entries and appends its own group', () => {
    const existing = {
      hooks: {
        SessionStart: [
          { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'bash o9k-core-session.sh' }] },
        ],
      },
    };
    const next = mergeCodexSessionStart(existing, 'bash /x/tim-session-start.sh');
    expect(next.hooks?.SessionStart).toHaveLength(2);
    expect(JSON.stringify(next)).toContain('o9k-core-session.sh');
  });

  it('recognizes a hand-placed tim-session-start.sh instead of duplicating it', () => {
    const existing = {
      hooks: {
        SessionStart: [
          { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'bash /home/u/.codex/hooks/tim-session-start.sh' }] },
        ],
      },
    };
    expect(mergeCodexSessionStart(existing, 'bash /other/tim-session-start.sh')).toBe(existing);
  });

  it('writes hooks.json when absent and is idempotent', () => {
    expect(installCodexSessionStartHook({ hooksPath, script })).toMatchObject({ status: 'installed' });
    expect(installCodexSessionStartHook({ hooksPath, script })).toMatchObject({ status: 'unchanged' });
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  it('refuses to touch invalid JSON', () => {
    fs.writeFileSync(hooksPath, '{ not json');
    expect(installCodexSessionStartHook({ hooksPath, script })).toMatchObject({ status: 'skip' });
  });
});
