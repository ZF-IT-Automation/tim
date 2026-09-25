import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  syncLockPath,
  tryAcquireSyncLock,
  withSyncMutationSync,
} from '../lock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const holdScript = path.join(here, 'helpers', 'hold-sync-lock.mjs');

function holdLock(name: string, home: string): Promise<{ kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [holdScript, name], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`lock holder did not start: ${stderr}`));
    }, 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) {
        clearTimeout(timer);
        resolve({ kill: () => child.kill('SIGTERM') });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited ${code}: ${stderr}`));
    });
  });
}

describe('sync locks', () => {
  it('recovers a lock whose pid is dead', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-lock-stale-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const file = syncLockPath('mutation');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({
        pid: 2_147_483_646,
        starttime: '1',
        token: 'stale',
        acquiredAt: '2020-01-01T00:00:00.000Z',
      }), { mode: 0o644 });
      const lock = tryAcquireSyncLock('mutation');
      expect(lock).not.toBeNull();
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; token: string };
      expect(record.pid).toBe(process.pid);
      expect(record.token).not.toBe('stale');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      lock!.release();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      process.env.HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not steal a live holder, then acquires after that process exits', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-lock-live-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    const holder = await holdLock('mutation', home);
    try {
      expect(tryAcquireSyncLock('mutation')).toBeNull();
      holder.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const lock = tryAcquireSyncLock('mutation');
      expect(lock).not.toBeNull();
      lock!.release();
    } finally {
      holder.kill();
      process.env.HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('serializes mutation so a stale in-memory epoch cannot overwrite', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-lock-epoch-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      let cursor = 'none';
      withSyncMutationSync(() => {
        cursor = 'first';
      });
      withSyncMutationSync(() => {
        cursor = 'second';
      });
      expect(cursor).toBe('second');
    } finally {
      process.env.HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
