import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TimStore } from '../index.js';
import type { Entry } from 'tim-core';

const ENSURE_INBOX_WORKER = fileURLToPath(
  new URL('./helpers/ensure-inbox-worker.mjs', import.meta.url),
);

function waitForMessage(
  child: ChildProcess,
  type: 'ready' | 'result' | 'error',
): Promise<{ type: string; id?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker timeout waiting for ${type}`)), 10_000);
    const onMessage = (message: { type?: string; id?: string; error?: string }) => {
      if (message.type !== type && message.type !== 'error') return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message as { type: string; id?: string; error?: string });
    };
    child.on('message', onMessage);
    child.once('error', reject);
  });
}

describe('concurrent TimStore', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `tim-concurrent-${crypto.randomBytes(8).toString('hex')}.db`,
    );
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
      } catch {
        // ignore cleanup races
      }
    }
  });

  it('busy_timeout allows concurrent writers to wait', async () => {
    const store1 = new TimStore(dbPath);
    const store2 = new TimStore(dbPath);

    try {
      const [entry1, entry2] = await Promise.all([
        store1.createProject('P1001', { content: 'Project A' }),
        store2.createProject('P1002', { content: 'Project B' }),
      ]);

      expect(entry1.metadata.label).toBe('P1001');
      expect(entry2.metadata.label).toBe('P1002');
    } finally {
      store1.close();
      store2.close();
    }
  });

  it('concurrent createProject with same label — exactly one succeeds', async () => {
    const store1 = new TimStore(dbPath);
    const store2 = new TimStore(dbPath);

    try {
      const [result1, result2] = await Promise.all([
        store1.createProject('P9999').then(
          (entry): { ok: true; entry: Entry } => ({ ok: true, entry }),
          (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
        ),
        store2.createProject('P9999').then(
          (entry): { ok: true; entry: Entry } => ({ ok: true, entry }),
          (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
        ),
      ]);

      expect(result1.ok !== result2.ok).toBe(true);

      const success = result1.ok ? result1 : result2;
      const failure = result1.ok ? result2 : result1;

      expect(success.ok).toBe(true);
      if (success.ok) {
        expect(success.entry.metadata.label).toBe('P9999');
      }

      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error).toBeInstanceOf(Error);
        expect(String(failure.error)).toMatch(
          /Project label already exists|SQLITE_CONSTRAINT|UNIQUE/i,
        );
      }
    } finally {
      store1.close();
      store2.close();
    }
  });

  it('overlapping child processes converge on one Inbox row and one staging write', async () => {
    const bootstrap = new TimStore(dbPath);
    bootstrap.close();
    const workers = [1, 2].map(() => {
      const child = fork(ENSURE_INBOX_WORKER, [], {
        env: { ...process.env, TIM_DB_PATH: dbPath },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      return { child, ready: waitForMessage(child, 'ready') };
    });
    const children = workers.map(worker => worker.child);
    try {
      await Promise.all(workers.map(worker => worker.ready));
      const results = children.map(child => {
        const result = waitForMessage(child, 'result');
        child.send('go');
        return result;
      });
      const messages = await Promise.all(results);
      expect(messages).toEqual([
        { type: 'result', id: 'P0000' },
        { type: 'result', id: 'P0000' },
      ]);

      const verifier = new TimStore(dbPath);
      const row = verifier.getDb().prepare(
        `SELECT COUNT(*) AS count FROM entries WHERE id = 'P0000'`,
      ).get() as { count: number };
      const staging = verifier.getDb().prepare(
        `SELECT COUNT(*) AS count FROM staging WHERE key = 'P0000'`,
      ).get() as { count: number };
      expect(row.count).toBe(1);
      expect(staging.count).toBe(1);
      verifier.close();
    } finally {
      for (const child of children) child.kill('SIGTERM');
    }
  }, 15_000);
});
