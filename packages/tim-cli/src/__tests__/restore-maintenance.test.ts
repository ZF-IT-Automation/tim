import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireMaintenanceLock,
  assertMaintenanceClear,
  maintenanceLockPathForDb,
} from 'tim-core';

describe('restore maintenance lock ordering', () => {
  it('writer can start only after maintenance lock is released', () => {
    const dbPath = path.join(os.tmpdir(), `tim-restore-lock-${process.pid}.db`);
    const lockPath = maintenanceLockPathForDb(dbPath);
    const handle = acquireMaintenanceLock({ dbPath, operation: 'restore', lockPath });

    expect(() => assertMaintenanceClear(dbPath)).toThrow(/maintenance in progress/);

    handle.release();
    expect(() => assertMaintenanceClear(dbPath)).not.toThrow();

    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  });
});
