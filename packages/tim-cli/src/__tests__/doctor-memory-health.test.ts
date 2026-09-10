import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore, SessionManager } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');

function runDoctor(dbPath: string, home: string): string {
  return execFileSync('node', [CLI, 'doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TIM_DB_PATH: dbPath,
      TIM_EMBEDDING_DISABLED: '1',
    },
  });
}

describe('tim doctor memory health integration', () => {
  let root: string;
  let home: string;
  let dbPath: string;
  let store: TimStore;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-doctor-mem-'));
    home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    dbPath = path.join(root, 'tim.db');
    store = new TimStore(dbPath);
    await store.createProject('P3700');
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'doctor-session',
      projectId: 'P3700',
      agentName: 'a',
      cwd: '/',
      harness: 't',
      batchSize: 5,
    });
    await sessions.logExchange('doctor-session', [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
    ]);
    store.close();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs doctor end-to-end and prints memory coverage without mutating the database', () => {
    const beforeEntries = (
      new TimStore(dbPath).getDb().prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }
    ).c;
    const beforeAccessed = (
      new TimStore(dbPath).getDb().prepare(
        'SELECT accessed_at FROM entries ORDER BY updated_at DESC LIMIT 1',
      ).get() as { accessed_at: string }
    ).accessed_at;
    new TimStore(dbPath).close();

    const output = runDoctor(dbPath, home);
    expect(output).toContain('Memory exchanges:');
    expect(output).toContain('pending');
    expect(output).toContain('Semantic index:');
    expect(output).toContain('Sync telemetry:');

    const afterStore = new TimStore(dbPath);
    const afterEntries = (
      afterStore.getDb().prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }
    ).c;
    const afterAccessed = (
      afterStore.getDb().prepare(
        'SELECT accessed_at FROM entries ORDER BY updated_at DESC LIMIT 1',
      ).get() as { accessed_at: string }
    ).accessed_at;
    const vectorCount = (
      afterStore.getDb().prepare('SELECT COUNT(*) AS c FROM entry_vectors').get() as { c: number }
    ).c;
    afterStore.close();

    expect(afterEntries).toBe(beforeEntries);
    expect(afterAccessed).toBe(beforeAccessed);
    expect(vectorCount).toBe(0);
  });
});
