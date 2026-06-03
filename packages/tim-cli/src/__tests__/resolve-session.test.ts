import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore, SessionManager } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = '/tmp/tim-test-runs';

function run(args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('tim resolve-session', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'resolve-sess-'));
    dbPath = path.join(dir, 'test.db');
    const store = new TimStore(dbPath);
    await store.createProject('P0077', { content: 'resolve-session test' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'hermes-sess-a',
      projectId: 'P0077',
      agentName: 'a',
      cwd: dir,
      harness: 'hermes',
    });
    store.close();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('prints project_ref label for known session', () => {
    expect(
      run(['resolve-session', '--session', 'hermes-sess-a'], { TIM_DB_PATH: dbPath }).trim(),
    ).toBe('P0077');
  });

  it('prints nothing for unknown session', () => {
    expect(
      run(['resolve-session', '--session', 'missing'], { TIM_DB_PATH: dbPath }).trim(),
    ).toBe('');
  });

  it('directive cites TIM session binding', () => {
    const out = run(
      ['resolve-session', '--session', 'hermes-sess-a', '--cwd', dir, '--format', 'directive'],
      { TIM_DB_PATH: dbPath },
    );
    expect(out).toContain('TIM session bound');
    expect(out).toContain('tim_load_project(label="P0077")');
  });
});
