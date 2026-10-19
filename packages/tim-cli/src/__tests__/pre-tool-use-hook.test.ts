import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENTRY = path.resolve(__dirname, '../../dist/pre-tool-use-hook.js');

describe('pre-tool-use-hook.js', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-pre-tool-use-'));
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.tim'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(payload: unknown, config?: unknown) {
    if (config) fs.writeFileSync(path.join(home, '.tim', 'config.json'), JSON.stringify(config));
    return spawnSync(process.execPath, [ENTRY], {
      cwd: root,
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TIM_DB_PATH: path.join(root, 'tim.db') },
    });
  }

  it.each([
    ['another tool', { tool_name: 'Read', tool_input: { file_path: '/x' } }, { hooks: { preToolUse: { enabled: true } } }],
    ['a harmless command', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: '/tmp' }, { hooks: { preToolUse: { enabled: true } } }],
    ['the guard switched off', { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/tmp' }, undefined],
    ['no Jev key and no project', { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/tmp' }, { hooks: { preToolUse: { enabled: true } } }],
    ['broken input', 'not json', undefined],
  ])('prints nothing and exits 0 for %s', (_name, payload, config) => {
    const result = run(payload, config);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  // Opening the store creates the database file; the gated-out cases above cannot tell a broken
  // import from a closed gate, since both print nothing.
  it('opens the store only once the gates pass', () => {
    run({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: root });
    expect(fs.existsSync(path.join(root, 'tim.db'))).toBe(false);
    const result = run({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: root }, { hooks: { preToolUse: { enabled: true } } });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(root, 'tim.db'))).toBe(true);
  });
});
