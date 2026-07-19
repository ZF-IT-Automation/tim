import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore, CommitManager, SessionManager } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');

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

describe('tim record-commit', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'record-commit-'));
    dbPath = path.join(dir, 'test.db');
    const store = new TimStore(dbPath);
    await store.createProject('P0002', { content: 'CLI test project' });
    store.close();
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        version: 3,
        project: 'P0002',
      }),
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('records commit with explicit args', async () => {
    const out = run(
      [
        'record-commit',
        '--cwd', dir,
        '--hash', 'abc1234567890',
        '--message', 'feat: test commit',
        '--diff', '1 file changed',
      ],
      { TIM_DB_PATH: dbPath },
    );
    const entry = JSON.parse(out);
    expect(entry.title).toBe('abc1234567890');
    expect(entry.content).toContain('feat: test commit');

    const store = new TimStore(dbPath);
    const mgr = new CommitManager(store);
    const section = await mgr.ensureCommitsSection('P0002');
    const commits = await store.getChildByKind(section.id, 'commit');
    expect(commits).toHaveLength(1);
    store.close();
  });

  it('supports equals syntax and values beginning with --', () => {
    const out = run(
      [
        'record-commit',
        `--cwd=${dir}`,
        '--hash=leading-dash',
        '--message', '--fix parser',
      ],
      { TIM_DB_PATH: dbPath },
    );
    const entry = JSON.parse(out);
    expect(entry.title).toBe('leading-dash');
    expect(entry.content).toContain('--fix parser');
  });

  it('resolves session from store when --session omitted', async () => {
    const store = new TimStore(dbPath);
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-rc',
      projectId: 'P0002',
      agentName: 't',
      cwd: dir,
      harness: 'hermes',
    });
    store.close();

    const out = run(
      [
        'record-commit',
        '--cwd', dir,
        '--hash', 'sesshash',
        '--message', 'with session',
      ],
      { TIM_DB_PATH: dbPath },
    );
    const entry = JSON.parse(out);
    const verify = new TimStore(dbPath);
    const edges = await verify.getEdges(entry.id, 'outgoing');
    expect(edges.some(e => e.targetId === 'sess-rc' && e.type === 'relates')).toBe(true);
    verify.close();
  });

  it('honors explicit --session flag', async () => {
    const store = new TimStore(dbPath);
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'sess-current',
      projectId: 'P0002',
      agentName: 't',
      cwd: dir,
      harness: 'hermes',
    });
    await sessions.startProjectSession({
      sessionId: 'sess-explicit',
      projectId: 'P0002',
      agentName: 't',
      cwd: dir,
      harness: 'hermes',
    });
    store.close();

    const out = run(
      [
        'record-commit',
        '--cwd', dir,
        '--session', 'sess-explicit',
        '--hash', 'explicit-sess',
        '--message', 'explicit session',
      ],
      { TIM_DB_PATH: dbPath },
    );
    const entry = JSON.parse(out);
    const verify = new TimStore(dbPath);
    const edges = await verify.getEdges(entry.id, 'outgoing');
    expect(edges.some(e => e.targetId === 'sess-explicit' && e.type === 'relates')).toBe(true);
    verify.close();
  });

  it('is idempotent for the same hash', async () => {
    const env = { TIM_DB_PATH: dbPath };
    run(
      ['record-commit', '--cwd', dir, '--hash', 'duphash', '--message', 'first'],
      env,
    );
    run(
      ['record-commit', '--cwd', dir, '--hash', 'duphash', '--message', 'second'],
      env,
    );
    const store = new TimStore(dbPath);
    const mgr = new CommitManager(store);
    const section = await mgr.ensureCommitsSection('P0002');
    const commits = await store.getChildByKind(section.id, 'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.content).toContain('first');
    store.close();
  });

  it('exits 0 silently when no marker', () => {
    const bare = fs.mkdtempSync(path.join(TEST_ROOT, 'bare-'));
    try {
      expect(
        run(['record-commit', '--cwd', bare], { TIM_DB_PATH: dbPath, TIM_MARKER_MAX_ROOT: bare }).trim(),
      ).toBe('');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
