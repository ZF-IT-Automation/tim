import type { TimStore } from 'tim-store';
import type { SyncConfig } from './config.js';
import { getDeviceId } from './config.js';
import { SyncApiError, PERMANENT_SYNC_CODES } from './client.js';
import { MissingSecretPassphraseError } from './credentials.js';
import {
  syncDbIdentity,
  syncOwnerLockName,
  tryAcquireSyncLock,
  type SyncLockHandle,
} from './lock.js';
import {
  buildSyncContext,
  formatSyncFailure,
  runPull,
  runPush,
  syncCycleExitCode,
  thrownSyncExitCode,
  type PushCycleResult,
} from './sync.js';

export const OWNER_DEFAULT_INTERVAL_MS = 30_000;
export const OWNER_DEFAULT_DEADLINE_MS = 20_000;

export interface OwnerPullResult {
  pulled: number;
  conflicts: number;
  complete: boolean;
  permanent: boolean;
  errorCode: string | null;
}

export interface OwnerCycleResult {
  alreadyOwned: boolean;
  exitCode: number;
  push: PushCycleResult | null;
  pull: OwnerPullResult | null;
}

export interface SyncOwnerOptions {
  store: TimStore;
  config: SyncConfig;
  passphrase: string;
  deviceId?: string;
  secretPassphrase?: string;
  once?: boolean;
  intervalMs?: number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One periodic sync owner for a database. Does not install a service.
 * A second live owner returns immediately with exit code 0.
 * Mirror is not implemented; it must take `withSyncMutationAsync` when it is.
 */
export async function runSyncOwner(options: SyncOwnerOptions): Promise<OwnerCycleResult> {
  const identity = syncDbIdentity(options.store.getDatabasePath());
  const owner: SyncLockHandle | null = tryAcquireSyncLock(syncOwnerLockName(identity));
  if (!owner) {
    return { alreadyOwned: true, exitCode: 0, push: null, pull: null };
  }
  const intervalMs = options.intervalMs ?? OWNER_DEFAULT_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? OWNER_DEFAULT_DEADLINE_MS;
  const sleep = options.sleep ?? defaultSleep;
  try {
    let last: OwnerCycleResult = { alreadyOwned: false, exitCode: 0, push: null, pull: null };
    for (;;) {
      last = await runOwnerCycle(options, deadlineMs);
      if (options.once || last.exitCode === 1 || last.exitCode === 3) return last;
      if (last.exitCode === 2) {
        await sleep(intervalMs);
        continue;
      }
      await sleep(intervalMs);
    }
  } finally {
    owner.release();
  }
}

async function runOwnerCycle(options: SyncOwnerOptions, deadlineMs: number): Promise<OwnerCycleResult> {
  const deadlineAt = Date.now() + deadlineMs;
  const ctx = buildSyncContext(
    options.store,
    options.config,
    options.passphrase,
    options.deviceId ?? getDeviceId(),
    options.secretPassphrase,
  );
  let push: PushCycleResult;
  try {
    push = await runPush(ctx, { deadlineAt, sleep: options.sleep });
  } catch (err) {
    return {
      alreadyOwned: false,
      exitCode: thrownSyncExitCode(err),
      push: null,
      pull: null,
    };
  }
  if (push.permanent && (push.errorCode?.startsWith('UNAUTHORIZED') || push.errorCode?.startsWith('REVOKED'))) {
    return { alreadyOwned: false, exitCode: 3, push, pull: null };
  }
  let pull: OwnerPullResult;
  try {
    const result = await runPull(ctx, { deadlineAt });
    pull = { ...result, complete: true, permanent: false, errorCode: null };
  } catch (err) {
    const permanent = err instanceof SyncApiError && PERMANENT_SYNC_CODES.has(err.code);
    pull = {
      pulled: 0,
      conflicts: 0,
      complete: false,
      permanent,
      errorCode: formatSyncFailure(err),
    };
    if (err instanceof MissingSecretPassphraseError) {
      return { alreadyOwned: false, exitCode: 1, push, pull };
    }
  }
  const exitCode = Math.max(syncCycleExitCode(push), syncCycleExitCode(pull));
  return { alreadyOwned: false, exitCode, push, pull };
}
