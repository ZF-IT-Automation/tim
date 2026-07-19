// Regression tests for scripts/tim-session-start.sh — output envelope per
// harness payload shape, and marker immutability during session start.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/tim-session-start.sh',
);
const SCRIPTS_DIR = path.dirname(SCRIPT);
const RELOCATED_ENTRYPOINTS = [
  'tim-claude-session-start.sh',
  'post-commit.sh',
  'tim-session-start.sh',
  'tim-post-commit.sh',
  'tim-hermes-session-cache.sh',
  'tim-hermes-statusline.sh',
  'tim-cursor-inject.sh',
  'tim-statusline.sh',
];

let tmpDir: string;
let stubCli: string;

function runScript(payload: string): string {
  return execFileSync('bash', [SCRIPT], {
    input: payload,
    env: { ...process.env, TIM_CLI: stubCli },
    encoding: 'utf8',
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-session-start-'));
  // Stub tim CLI: always resolves a directive, regardless of args.
  stubCli = path.join(tmpDir, 'stub-cli.js');
  fs.writeFileSync(stubCli, 'console.log("TIM DIRECTIVE");\n');
  fs.writeFileSync(
    path.join(tmpDir, '.tim-project'),
    JSON.stringify({ project: 'P0063', session: 'old-session' }, null, 2),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tim-session-start.sh output envelopes', () => {
  it('emits the Claude Code hook envelope for a real SessionStart input payload', () => {
    const out = JSON.parse(runScript(JSON.stringify({
      session_id: '0d9bda6b-cd0e-4a88-9d06-7db9476f56d7',
      transcript_path: '/home/bbbee/.claude/projects/-home-bbbee-projects-tim/session.jsonl',
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4-1',
    })));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'TIM DIRECTIVE',
      },
    });
  });

  it('emits Claude Code hook envelope for payloads with hookSpecificOutput', () => {
    const out = JSON.parse(runScript(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart' },
      cwd: tmpDir,
      session_id: 's-claude',
    })));
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toBe('TIM DIRECTIVE');
  });

  it('emits Cursor envelope for payloads with conversation_id', () => {
    const out = JSON.parse(runScript(JSON.stringify({
      conversation_id: 'c-1',
      cwd: tmpDir,
    })));
    expect(out).toEqual({ additional_context: 'TIM DIRECTIVE' });
  });

  it('emits JSON {context} for Hermes/Codex payloads with session_id (PITFALLS-45)', () => {
    const out = JSON.parse(runScript(JSON.stringify({
      session_id: 's-hermes',
      cwd: tmpDir,
    })));
    expect(out).toEqual({ context: 'TIM DIRECTIVE' });
  });

  it('falls back to Cursor-safe envelope on empty stdin', () => {
    const out = JSON.parse(execFileSync('bash', [SCRIPT], {
      input: '',
      env: { ...process.env, TIM_CLI: stubCli },
      encoding: 'utf8',
      cwd: tmpDir,
    }));
    expect(out).toEqual({ additional_context: 'TIM DIRECTIVE' });
  });
});

describe('tim-session-start.sh marker immutability', () => {
  it('does not rewrite .tim-project when emitting the directive', () => {
    const markerPath = path.join(tmpDir, '.tim-project');
    const before = fs.readFileSync(markerPath);
    const mtimeBefore = fs.statSync(markerPath).mtimeMs;
    runScript(JSON.stringify({ session_id: 's-new', cwd: tmpDir }));
    const after = fs.readFileSync(markerPath);
    const mtimeAfter = fs.statSync(markerPath).mtimeMs;
    expect(after.equals(before)).toBe(true);
    expect(mtimeAfter).toBe(mtimeBefore);
    const marker = JSON.parse(after.toString('utf8'));
    expect(marker.project).toBe('P0063');
    expect(marker.session).toBe('old-session');
  });
});

describe('relocatable hook installation', () => {
  it('runs every symlinked entrypoint with BSD-style readlink from a spaced prefix', () => {
    const installRoot = path.join(tmpDir, 'Different Home', 'TIM Install With Spaces');
    const relocatedScripts = path.join(installRoot, 'node_modules', 'tim-hooks', 'scripts');
    const relocatedHome = path.join(tmpDir, 'Relocated User Home');
    const hookLinks = path.join(relocatedHome, 'agent hooks with spaces');
    const fakeBin = path.join(tmpDir, 'fake bin');
    const fakeLog = path.join(tmpDir, 'tim-invocations.log');
    const readlinkLog = path.join(tmpDir, 'readlink-invocations.log');
    const repo = path.join(tmpDir, 'git repo');
    fs.cpSync(SCRIPTS_DIR, relocatedScripts, { recursive: true });
    fs.mkdirSync(relocatedHome, { recursive: true });
    fs.mkdirSync(hookLinks, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });

    const fakeTim = path.join(fakeBin, 'tim');
    fs.writeFileSync(fakeTim, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TIM_FAKE_LOG"
case " $* " in
  *" resolve-project "*) printf '%s\\n' 'TIM DIRECTIVE' ;;
  *" statusline "*) printf '%s\\n' '{"project":"P0063"}' ;;
esac
`);
    fs.chmodSync(fakeTim, 0o755);

    const systemReadlink = execFileSync('which', ['readlink'], { encoding: 'utf8' }).trim();
    const fakeReadlink = path.join(fakeBin, 'readlink');
    fs.writeFileSync(fakeReadlink, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TIM_READLINK_LOG"
if [[ "\${1:-}" == "-f" ]]; then
  printf '%s\\n' 'readlink: -f unsupported' >&2
  exit 64
fi
exec ${JSON.stringify(systemReadlink)} "$@"
`);
    fs.chmodSync(fakeReadlink, 0o755);

    for (const entrypoint of RELOCATED_ENTRYPOINTS) {
      fs.symlinkSync(path.join(relocatedScripts, entrypoint), path.join(hookLinks, entrypoint));
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: relocatedHome,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      TIM_FAKE_LOG: fakeLog,
      TIM_READLINK_LOG: readlinkLog,
    };
    delete env.TIM_CLI;

    const payloads: Record<string, { args?: string[]; input?: string }> = {
      'tim-claude-session-start.sh': { input: JSON.stringify({ cwd: repo }) },
      'post-commit.sh': {},
      'tim-session-start.sh': {
        input: JSON.stringify({ cwd: repo, conversation_id: 'relocated-session' }),
      },
      'tim-post-commit.sh': {},
      'tim-hermes-session-cache.sh': {
        input: JSON.stringify({ cwd: repo, session_id: 'relocated-session' }),
      },
      'tim-hermes-statusline.sh': {},
      'tim-cursor-inject.sh': { args: [repo] },
      'tim-statusline.sh': {},
    };

    for (const entrypoint of RELOCATED_ENTRYPOINTS) {
      const invocation = payloads[entrypoint];
      expect(() => execFileSync('bash', [path.join(hookLinks, entrypoint), ...(invocation.args ?? [])], {
        cwd: repo,
        env,
        input: invocation.input ?? '',
        encoding: 'utf8',
      }), entrypoint).not.toThrow();
    }

    const invocations = fs.readFileSync(fakeLog, 'utf8');
    expect(invocations).toContain('resolve-project');
    expect(invocations).toContain('statusline');
    expect(invocations).toContain('record-commit');
    const readlinkInvocations = fs.readFileSync(readlinkLog, 'utf8').trim().split('\n');
    expect(readlinkInvocations.length).toBeGreaterThanOrEqual(RELOCATED_ENTRYPOINTS.length);
    expect(readlinkInvocations.every((args) => !args.startsWith('-f'))).toBe(true);
  });

  it('falls back to the relocated sibling tim-cli package when tim is absent from PATH', () => {
    const installRoot = path.join(tmpDir, 'Fallback Install With Spaces', 'node_modules');
    const relocatedScripts = path.join(installRoot, 'tim-hooks', 'scripts');
    const cliDist = path.join(installRoot, 'tim-cli', 'dist');
    const toolBin = path.join(tmpDir, 'minimal tools');
    fs.cpSync(SCRIPTS_DIR, relocatedScripts, { recursive: true });
    fs.mkdirSync(cliDist, { recursive: true });
    fs.mkdirSync(toolBin, { recursive: true });
    fs.writeFileSync(path.join(cliDist, 'cli.js'), 'console.log("FALLBACK DIRECTIVE");\n');

    for (const command of ['cat', 'dirname', 'jq', 'node', 'readlink']) {
      const resolved = execFileSync('which', [command], { encoding: 'utf8' }).trim();
      fs.symlinkSync(resolved, path.join(toolBin, command));
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(tmpDir, 'Fallback Home'),
      PATH: toolBin,
    };
    delete env.TIM_CLI;

    const out = execFileSync('/bin/bash', [path.join(relocatedScripts, 'tim-session-start.sh')], {
      cwd: tmpDir,
      env,
      input: JSON.stringify({ cwd: tmpDir, conversation_id: 'fallback-session' }),
      encoding: 'utf8',
    });

    expect(JSON.parse(out)).toEqual({ additional_context: 'FALLBACK DIRECTIVE' });
  });
});
