import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Create a directory at mode 0700, or tighten one we own.
 * A directory we cannot chmod (for example `/tmp`) is left unchanged.
 */
export function ensurePrivateDir(dir: string): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (existed && (code === 'EPERM' || code === 'EACCES')) return;
    throw err;
  }
}

/**
 * Replace `target` with `data` by renaming a unique 0600 temporary file in the same directory.
 * Failure, including a full disk, removes only the temporary file. The previous target stays.
 */
export function atomicWritePrivate(target: string, data: string | Buffer): void {
  const dir = dirname(target);
  ensurePrivateDir(dir);
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
    chmodSync(target, 0o600);
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* the original error is the one to throw */ }
    }
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
}

/** Exclusive create. EEXIST is thrown for the caller to resolve. */
export function atomicCreatePrivate(target: string, data: string): void {
  const dir = dirname(target);
  ensurePrivateDir(dir);
  const fd = openSync(target, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, 0o600);
}
