import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore, SessionManager, EMPTY_SESSION_AGE_FLOOR_MS } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = '/tmp/tim-test-runs';
const HOUR = 60 * 60 * 1000;

function run(args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

describe('tim sessions reap', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'reap-'));
    dbPath = path.join(dir, 'tim.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dry-run prints the empty session and --ids refuses the running session', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0091', { content: 'cli reap' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'bare',
      projectId: 'P0091',
      agentName: 'a',
      cwd: dir,
      harness: 'test',
    });
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - EMPTY_SESSION_AGE_FLOOR_MS - HOUR).toISOString(),
      'bare',
    );
    await sessions.startProjectSession({
      sessionId: 'keeper',
      projectId: 'P0091',
      agentName: 'a',
      cwd: dir,
      harness: 'test',
    });
    await sessions.startProjectSession({
      sessionId: 'running',
      projectId: 'P0091',
      agentName: 'a',
      cwd: dir,
      harness: 'test',
    });
    await sessions.logExchange('running', [{ role: 'user', content: 'still here' }]);
    store.close();

    const env = { TIM_DB_PATH: dbPath, TIM_SESSION_ID: 'running' };
    const dry = run(['sessions', 'reap', '--dry-run', '--project', 'P0091'], env);
    expect(dry).toContain('would reap bare');
    expect(dry).toContain('project=P0091');
    expect(dry).not.toContain('would reap keeper');
    expect(dry).not.toContain('would reap running');

    const idsFile = path.join(dir, 'ids.txt');
    fs.writeFileSync(idsFile, 'bare\nrunning\n');
    const byId = run(['sessions', 'reap', '--ids', idsFile], env);
    expect(byId).toContain('reaped bare children=');
    expect(byId).toContain('refused running children=');
    expect(byId).toContain('running session');

    const check = new TimStore(dbPath);
    expect(await check.read('bare')).toBeNull();
    expect(await check.read('running')).not.toBeNull();
    expect(await check.read('keeper')).not.toBeNull();
    check.close();
  });

  it('puts a reap line on the session-start directive', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0091', { content: 'directive reap' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'ancient',
      projectId: 'P0091',
      agentName: 'a',
      cwd: dir,
      harness: 'test',
    });
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - EMPTY_SESSION_AGE_FLOOR_MS - HOUR).toISOString(),
      'ancient',
    );
    await sessions.startProjectSession({
      sessionId: 'keeper',
      projectId: 'P0091',
      agentName: 'a',
      cwd: dir,
      harness: 'test',
    });
    store.close();

    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({ version: 3, project: 'P0091' }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], {
      TIM_DB_PATH: dbPath,
      TIM_MARKER_MAX_ROOT: dir,
    });
    expect(out).toContain('reaped 1 empty sessions');
    expect(out).toContain('tim_load_project(label="P0091")');

    const check = new TimStore(dbPath);
    expect(await check.read('ancient')).toBeNull();
    expect(await check.read('keeper')).not.toBeNull();
    check.close();
  });
});
