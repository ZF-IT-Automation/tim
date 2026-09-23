import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
} from 'tim-store';

const WORKER = fileURLToPath(new URL('./helpers/backfill-update-worker.mjs', import.meta.url));

function waitForMessage(
  child: ChildProcess,
  type: 'ready' | 'result' | 'error',
): Promise<{ type: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker timeout waiting for ${type}`)), 15_000);
    const onMessage = (message: { type?: string; error?: string }) => {
      if (message.type !== type && message.type !== 'error') return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message as { type: string; error?: string });
    };
    child.on('message', onMessage);
    child.once('error', reject);
  });
}

describe('backfill substance write retry', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `tim-backfill-busy-${crypto.randomBytes(8).toString('hex')}.db`);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('waits for a brief exclusive lock instead of failing immediately', async () => {
    const setup = new TimStore(dbPath);
    const project = await setup.createProject('P8800', { content: 'backfill busy test' });
    const sessions = new SessionManager(setup);
    await sessions.startProjectSession({
      sessionId: 'bf-sess',
      projectId: project.metadata.label ?? 'P8800',
      agentName: 'test',
      cwd: '/tmp',
      harness: 'test',
    });
    for (let i = 1; i <= 3; i++) {
      await sessions.logExchange('bf-sess', [
        { role: 'user', content: `q${i}` },
        { role: 'agent', content: `a${i}` },
      ]);
    }
    const summaryNode = await findChildByKind(setup, 'bf-sess', KIND_SUMMARY_ROOT);
    expect(summaryNode).toBeTruthy();
    setup.close();

    const locker = new TimStore(dbPath);
    locker.getDb().prepare('BEGIN IMMEDIATE').run();

    const child = fork(WORKER, [], {
      env: {
        ...process.env,
        TIM_DB_PATH: dbPath,
        TIM_ENTRY_ID: summaryNode!.id,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    try {
      await waitForMessage(child, 'ready');
      const resultPromise = waitForMessage(child, 'result');
      child.send('go');
      await new Promise(r => setTimeout(r, 80));
      locker.getDb().prepare('COMMIT').run();
      locker.close();
      const result = await resultPromise;
      expect(result.type).toBe('result');
    } finally {
      child.kill('SIGTERM');
    }

    const verify = new TimStore(dbPath);
    const verified = await findChildByKind(verify, 'bf-sess', KIND_SUMMARY_ROOT);
    expect(verified?.metadata.substance).toBe('real');
    verify.close();
  }, 15_000);
});
