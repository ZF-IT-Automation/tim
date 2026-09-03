import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireMaintenanceLock,
  assertMaintenanceClear,
  isMaintenanceActive,
  maintenanceLockPathForDb,
} from '../maintenance-lock.js';

describe('maintenance-lock', () => {
  const dbPath = path.join(os.tmpdir(), `tim-test-${process.pid}.db`);
  let lockPath: string;

  afterEach(() => {
    try {
      if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  });

  it('blocks a second acquirer while maintenance is held', () => {
    lockPath = maintenanceLockPathForDb(dbPath);
    const first = acquireMaintenanceLock({ dbPath, operation: 'restore', lockPath });
    expect(isMaintenanceActive(dbPath, lockPath)).toBe(true);
    expect(() => acquireMaintenanceLock({ dbPath, operation: 'compact', lockPath })).toThrow(
      /maintenance already active/,
    );
    first.release();
    expect(isMaintenanceActive(dbPath, lockPath)).toBe(false);
  });

  it('assertMaintenanceClear throws while lock is held', () => {
    lockPath = maintenanceLockPathForDb(dbPath);
    const handle = acquireMaintenanceLock({ dbPath, operation: 'restore', lockPath });
    expect(() => assertMaintenanceClear(dbPath)).toThrow(/maintenance in progress/);
    handle.release();
    expect(() => assertMaintenanceClear(dbPath)).not.toThrow();
  });
});
