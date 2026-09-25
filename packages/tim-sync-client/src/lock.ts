import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getTimDir } from 'tim-core';
import { ensurePrivateDir } from './private-file.js';

export const SYNC_MUTATION_LOCK = 'mutation';

const mutationAls = new AsyncLocalStorage<true>();

export class SyncLockBusyError extends Error {
  readonly code = 'SYNC_LOCK_BUSY';

  constructor(readonly lockName: string) {
    super(`Sync lock '${lockName}' is held by another process`);
    this.name = 'SyncLockBusyError';
  }
}

interface LockRecord {
  pid: number;
  starttime: string | null;
  token: string;
  acquiredAt: string;
}

interface HeldLock {
  token: string;
  depth: number;
  path: string;
}

const held = new Map<string, HeldLock>();

export function insideSyncMutation(): boolean {
  return mutationAls.getStore() === true;
}

export function syncDbIdentity(dbPath: string): string {
  if (dbPath === ':memory:') return ':memory:';
  if (!existsSync(dbPath)) return dbPath;
  return realpathSync(dbPath);
}

export function syncOwnerLockName(dbIdentity: string): string {
  const digest = createHash('sha256').update(dbIdentity).digest('hex').slice(0, 32);
  return `owner-${digest}`;
}

export function syncLockPath(name: string): string {
  return join(getTimDir(), 'sync-locks', `${name}.lock`);
}

/** Linux starttime (field 22). Null when /proc is unavailable. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function readLock(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockRecord>;
    if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return {
      pid: parsed.pid,
      starttime: typeof parsed.starttime === 'string' ? parsed.starttime : null,
      token: parsed.token,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
    };
  } catch {
    return null;
  }
}

function holderAlive(record: LockRecord): boolean {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
  if (record.starttime) {
    const current = processStartTime(record.pid);
    if (current && current !== record.starttime) return false;
  }
  return true;
}

function writeLockFile(file: string, record: LockRecord): boolean {
  ensurePrivateDir(dirname(file));
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
  return true;
}

/** Rename a dead lock aside. Returns true when the path is free to create. */
function recoverStale(file: string): boolean {
  if (!existsSync(file)) return true;
  const current = readLock(file);
  if (current && holderAlive(current)) return false;
  const doomed = `${file}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(file, doomed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  const moved = readLock(doomed);
  if (moved && holderAlive(moved)) {
    try { renameSync(doomed, file); } catch { /* a new lock won the path */ }
    return false;
  }
  try { unlinkSync(doomed); } catch { /* already gone */ }
  return true;
}

export interface SyncLockHandle {
  release(): void;
}

export function tryAcquireSyncLock(name: string): SyncLockHandle | null {
  // Nesting inside one operation uses AsyncLocalStorage, not a second acquire.
  // A second acquire in this process is another owner and must not re-enter.
  if (held.has(name)) return null;
  const file = syncLockPath(name);
  const record: LockRecord = {
    pid: process.pid,
    starttime: processStartTime(process.pid),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  if (!writeLockFile(file, record)) {
    if (!recoverStale(file) || !writeLockFile(file, record)) return null;
  }
  held.set(name, { token: record.token, depth: 1, path: file });
  return { release: () => releaseHeld(name) };
}

function releaseHeld(name: string): void {
  const slot = held.get(name);
  if (!slot) return;
  slot.depth -= 1;
  if (slot.depth > 0) return;
  held.delete(name);
  const current = readLock(slot.path);
  if (current && current.token === slot.token) {
    try { unlinkSync(slot.path); } catch { /* already released */ }
  }
}

function holderIsThisProcess(name: string): boolean {
  const record = readLock(syncLockPath(name));
  return Boolean(record && record.pid === process.pid && holderAlive(record));
}

function acquireOrWaitSync(name: string, timeoutMs: number): SyncLockHandle {
  const start = Date.now();
  for (;;) {
    const lock = tryAcquireSyncLock(name);
    if (lock) return lock;
    if (holderIsThisProcess(name) || Date.now() - start >= timeoutMs) {
      throw new SyncLockBusyError(name);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

async function acquireOrWaitAsync(name: string, timeoutMs: number): Promise<SyncLockHandle> {
  const start = Date.now();
  for (;;) {
    const lock = tryAcquireSyncLock(name);
    if (lock) return lock;
    if (Date.now() - start >= timeoutMs) throw new SyncLockBusyError(name);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function withSyncMutationSync<T>(fn: () => T, timeoutMs = 30_000): T {
  if (insideSyncMutation()) return fn();
  const lock = acquireOrWaitSync(SYNC_MUTATION_LOCK, timeoutMs);
  try {
    return mutationAls.run(true, fn);
  } finally {
    lock.release();
  }
}

export async function withSyncMutationAsync<T>(
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (insideSyncMutation()) return fn();
  const lock = await acquireOrWaitAsync(SYNC_MUTATION_LOCK, timeoutMs);
  try {
    return await mutationAls.run(true, fn);
  } finally {
    lock.release();
  }
}

export function syncOwnerActive(dbIdentity: string): boolean {
  const record = readLock(syncLockPath(syncOwnerLockName(dbIdentity)));
  return Boolean(record && holderAlive(record));
}
