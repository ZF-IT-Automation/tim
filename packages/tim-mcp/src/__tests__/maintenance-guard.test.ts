import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { acquireMaintenanceLock, maintenanceLockPathForDb } from 'tim-core';
import { childServerCwd, childServerDbPath, isolateChildServerCwd } from './helpers/child-server-workspace.js';

isolateChildServerCwd();

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

describe('maintenance blocks new MCP writers', () => {
  let lock: ReturnType<typeof acquireMaintenanceLock> | null = null;

  afterEach(() => {
    lock?.release();
    lock = null;
  });

  it('refuses to start stdio MCP while maintenance lock is held', async () => {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    const dbPath = childServerDbPath();
    lock = acquireMaintenanceLock({ dbPath, operation: 'restore-test' });
    expect(fs.existsSync(maintenanceLockPathForDb(dbPath))).toBe(true);

    const proc = spawn('node', [SERVER_PATH], {
      cwd: childServerCwd(),
      env: { ...process.env, TIM_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      proc.on('exit', (code) => resolve({ code, stderr }));
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({ code: proc.exitCode, stderr });
      }, 3000);
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/maintenance in progress/i);
  }, 10000);
});
