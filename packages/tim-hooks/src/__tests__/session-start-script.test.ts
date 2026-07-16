// Regression tests for scripts/tim-session-start.sh — output envelope per
// harness payload shape, and marker session rotation with hostile values.

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

describe('tim-session-start.sh marker rotation', () => {
  it('rotates .tim-project session to the hook session id', () => {
    runScript(JSON.stringify({ session_id: 's-new', cwd: tmpDir }));
    const marker = JSON.parse(fs.readFileSync(path.join(tmpDir, '.tim-project'), 'utf8'));
    expect(marker.session).toBe('s-new');
    expect(marker.project).toBe('P0063');
  });

  it("survives session ids and paths containing quotes/backslashes", () => {
    const hostile = `s'\\"; require("fs").rmSync("x") //`;
    runScript(JSON.stringify({ session_id: hostile, cwd: tmpDir }));
    const marker = JSON.parse(fs.readFileSync(path.join(tmpDir, '.tim-project'), 'utf8'));
    expect(marker.session).toBe(hostile);
  });
});
