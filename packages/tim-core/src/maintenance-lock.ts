// Exclusive maintenance lock — blocks new MCP writers during restore/compaction.
// Lock file lives under os.tmpdir(), keyed by DB path hash.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MaintenanceLockMeta {
  pid: number;
  operation: string;
  dbPath: string;
  started: string;
}

export interface MaintenanceLockHandle {
  lockPath: string;
  release: () => void;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function maintenanceLockPathForDb(dbPath: string): string {
  const hash = crypto.createHash('sha256').update(dbPath).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `tim-maintenance-${hash}.lock`);
}

export function readMaintenanceLock(lockPath: string): MaintenanceLockMeta | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as MaintenanceLockMeta;
  } catch {
    return null;
  }
}

/** True when another live process holds maintenance on this DB. */
export function isMaintenanceActive(dbPath: string, lockPath = maintenanceLockPathForDb(dbPath)): boolean {
  const meta = readMaintenanceLock(lockPath);
  if (!meta) {
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
    return false;
  }
  if (!isProcessAlive(meta.pid)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
    return false;
  }
  return true;
}

export function assertMaintenanceClear(dbPath: string): void {
  if (isMaintenanceActive(dbPath)) {
    const lockPath = maintenanceLockPathForDb(dbPath);
    const meta = readMaintenanceLock(lockPath);
    const op = meta?.operation ?? 'maintenance';
    throw new Error(`database maintenance in progress (${op}); refusing to open writer`);
  }
}

/**
 * Acquire an exclusive maintenance lock. Fails if another live holder exists.
 * Caller must call release() in a finally block.
 */
export function acquireMaintenanceLock(opts: {
  dbPath: string;
  operation: string;
  lockPath?: string;
}): MaintenanceLockHandle {
  const lockPath = opts.lockPath ?? maintenanceLockPathForDb(opts.dbPath);
  if (isMaintenanceActive(opts.dbPath, lockPath)) {
    const meta = readMaintenanceLock(lockPath);
    throw new Error(
      `maintenance already active (${meta?.operation ?? 'unknown'}) for ${opts.dbPath}`,
    );
  }

  const meta: MaintenanceLockMeta = {
    pid: process.pid,
    operation: opts.operation,
    dbPath: opts.dbPath,
    started: new Date().toISOString(),
  };

  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(meta));
  } catch (e) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
    throw e;
  }

  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    },
  };
}
